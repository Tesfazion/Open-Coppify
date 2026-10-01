"""Render 9:16 clips with FFmpeg.

Why FFmpeg directly rather than MoviePy
---------------------------------------
MoviePy drives the same FFmpeg binary but re-muxes through Python, which is
markedly slower and gives no handle on real-time progress or cancellation.
The vertical re-framing maths is a handful of filter-graph strings, so we build
them ourselves. ``moviepy`` stays in ``requirements.txt`` because the README
documents it as an alternative, and the filter graph below is the thing it
would generate anyway.

Three re-framing modes are offered:

``crop``  centre-crop to 9:16 and upscale -- full-bleed, most TikTok-native
``blur``  blurred copy of the frame behind the pillarboxed original (default)
``fit``   scale down and pad with black bars
"""

from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path
from typing import Any, Callable

from config import (
    CLIP_AUDIO_BITRATE,
    CLIP_CRF,
    CLIP_MAX_SECONDS,
    CLIP_MIN_SECONDS,
    CLIP_PRESET,
    CLIP_TARGET_SECONDS,
    CLIPS_DIR,
    VERTICAL_HEIGHT,
    VERTICAL_WIDTH,
)
from jobs import JobContext
from services import ffmpeg_utils
from services.segmenter import select_clips

MANIFEST_PATH = CLIPS_DIR / "manifest.json"
CAPTION_MAX_CHARS = 42
CAPTION_MAX_LINES = 2
CAPTION_MAX_SECONDS = 4.0
CAPTION_GAP = 0.7

FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/arialbd.ttf"),
    Path("C:/Windows/Fonts/arial.ttf"),
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
]


# ---------------------------------------------------------------------------
# Filter graph
# ---------------------------------------------------------------------------
def _even(value: float) -> int:
    number = int(round(value))
    if number % 2:
        number -= 1
    return max(2, number)


def build_video_filter(
    src_width: int,
    src_height: int,
    *,
    mode: str = "blur",
    blur: float = 0.35,
    out_width: int = VERTICAL_WIDTH,
    out_height: int = VERTICAL_HEIGHT,
) -> str:
    """Build the ``-vf`` graph that turns a source frame into 9:16."""
    mode = (mode or "blur").lower()
    target_ar = out_width / out_height

    if not src_width or not src_height:
        # Unknown source size: let ffmpeg letterbox into the target.
        return (
            f"scale={out_width}:{out_height}:force_original_aspect_ratio=decrease"
            f":force_divisible_by=2:flags=lanczos,"
            f"pad={out_width}:{out_height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
        )

    src_ar = src_width / src_height

    # Already (very nearly) vertical at the target ratio: just rescale.
    if abs(src_ar - target_ar) < 0.02:
        return f"scale={out_width}:{out_height}:flags=lanczos,setsar=1"

    if mode == "crop":
        if src_ar > target_ar:
            # Too wide -> crop the sides to 9:16, then upscale.
            crop_h = _even(src_height)
            crop_w = _even(crop_h * target_ar)
            crop_w = min(crop_w, _even(src_width))
            crop_h = min(crop_h, _even(src_height))
        else:
            # Too tall -> crop top/bottom.
            crop_w = _even(src_width)
            crop_h = _even(crop_w / target_ar)
            crop_h = min(crop_h, _even(src_height))
            crop_w = min(crop_w, _even(src_width))
        x = max(0, (_even(src_width) - crop_w) // 2)
        y = max(0, (_even(src_height) - crop_h) // 2)
        return (
            f"crop={crop_w}:{crop_h}:{x}:{y},"
            f"scale={out_width}:{out_height}:flags=lanczos,setsar=1"
        )

    if mode == "fit":
        return (
            f"scale={out_width}:{out_height}:force_original_aspect_ratio=decrease"
            f":force_divisible_by=2:flags=lanczos,"
            f"pad={out_width}:{out_height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        )

    # mode == "blur": cover background + fitted foreground.
    radius = max(4, min(60, int(20 * max(0.1, blur)) + 4))
    scale = min(out_width / src_width, out_height / src_height)
    fg_w = _even(src_width * scale)
    fg_h = _even(src_height * scale)
    return (
        "split=2[bg][fg];"
        # ``increase`` alone can land on an odd pixel width (1920x1080 -> 3413),
        # and libx264 rejects odd dimensions with yuv420p, so pin to even.
        f"[bg]scale={out_width}:{out_height}:force_original_aspect_ratio=increase"
        f":force_divisible_by=2:flags=bicubic,"
        f"crop={out_width}:{out_height},boxblur=luma_radius={radius}:luma_power=2[bgb];"
        f"[fg]scale={fg_w}:{fg_h}:flags=lanczos[fgs];"
        "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1"
    )


# ---------------------------------------------------------------------------
# Captions
# ---------------------------------------------------------------------------
def _srt_timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    whole = int(seconds % 60)
    millis = int(round((seconds - math.floor(seconds)) * 1000))
    if millis == 1000:  # rounding carry
        millis = 0
        whole += 1
    return f"{hours:02d}:{minutes:02d}:{whole:02d},{millis:03d}"


def _wrap_caption(text: str) -> str:
    words = text.split()
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        candidate = current + [word]
        if len(" ".join(candidate)) > CAPTION_MAX_CHARS and current:
            lines.append(" ".join(current))
            current = [word]
            if len(lines) == CAPTION_MAX_LINES:
                break
        else:
            current = candidate
    if current and len(lines) < CAPTION_MAX_LINES:
        lines.append(" ".join(current))
    return "\n".join(lines[:CAPTION_MAX_LINES])


def build_caption_cues(
    transcript: dict[str, Any], start: float, end: float
) -> list[tuple[float, float, str]]:
    """Build ``(start, end, text)`` cues relative to the clip start."""
    words = [
        word
        for word in (transcript.get("words") or [])
        if word.get("start") is not None and word.get("end") is not None
    ]
    raw: list[tuple[float, float, str]] = []

    if words:
        cursor: list[str] = []
        cue_start: float | None = None
        previous_end: float | None = None
        for word in words:
            word_start = float(word["start"])
            word_end = float(word["end"])
            if word_end <= start or word_start >= end:
                previous_end = word_end
                continue
            token = str(word.get("word") or "").strip()
            if not token:
                continue

            gap = (word_start - previous_end) if previous_end is not None else 0.0
            too_long = (
                cursor
                and (
                    len(" ".join(cursor + [token])) > CAPTION_MAX_CHARS
                    or gap > CAPTION_GAP
                    or (word_end - cue_start) > CAPTION_MAX_SECONDS
                )
            )
            if too_long and cue_start is not None:
                raw.append((cue_start, float(previous_end or word_start), " ".join(cursor)))
                cursor = []
                cue_start = None

            if cue_start is None:
                cue_start = word_start
            cursor.append(token)
            previous_end = word_end

            if token.endswith((".", "!", "?", ",", ";", ":")) and (
                word_end - cue_start
            ) >= 0.8:
                raw.append((cue_start, word_end, " ".join(cursor)))
                cursor = []
                cue_start = None

        if cursor and cue_start is not None:
            raw.append((cue_start, float(previous_end or cue_start), " ".join(cursor)))
    else:
        # Fall back to segment-level captions.
        for segment in transcript.get("segments") or []:
            text = str(segment.get("text") or "").strip()
            if not text:
                continue
            seg_start = float(segment.get("start", 0.0))
            seg_end = float(segment.get("end", 0.0))
            if seg_end <= start or seg_start >= end:
                continue
            raw.append((seg_start, seg_end, text))

    cues: list[tuple[float, float, str]] = []
    for cue_start, cue_end, text in raw:
        clipped_start = max(cue_start, start) - start
        clipped_end = min(cue_end, end) - start
        if clipped_end - clipped_start < 0.25:
            continue
        wrapped = _wrap_caption(text)
        if not wrapped:
            continue
        cues.append((round(clipped_start, 3), round(clipped_end, 3), wrapped))
    return cues


def write_srt(cues: list[tuple[float, float, str]], path: Path) -> Path:
    blocks = []
    for index, (start, end, text) in enumerate(cues, start=1):
        blocks.append(
            f"{index}\n{_srt_timestamp(start)} --> {_srt_timestamp(end)}\n{text}\n"
        )
    path.write_text("\n".join(blocks), encoding="utf-8")
    return path


def _find_font() -> Path | None:
    override = None
    try:
        import os

        override = os.environ.get("COPPIFY_FONT_FILE")
    except Exception:  # noqa: BLE001
        override = None
    if override and Path(override).exists():
        return Path(override)
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return candidate
    return None


def build_subtitle_filter(srt_path: Path) -> str | None:
    """Style + attach an SRT file, or ``None`` if libass/fontconfig is absent."""
    escaped = ffmpeg_utils.escape_filter_path(srt_path)
    style = (
        "FontName=Arial,Bold,FontSize=20,PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,"
        "Alignment=2,MarginV=140,Bold=1"
    )
    # Commas separate filter options, so they must be escaped inside the value.
    escaped_style = style.replace(",", r"\,")
    return f"subtitles={escaped}:force_style='{escaped_style}'"


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def _run_with_progress(
    args: list[str],
    *,
    duration: float,
    on_progress: Callable[[float], None] | None,
    stage: str,
    is_cancelled: Callable[[], bool] | None = None,
) -> None:
    """Run ffmpeg, mapping ``time=`` output onto a 0..1 progress fraction."""
    process = ffmpeg_utils.spawn_ffmpeg(args)
    stderr_tail: list[str] = []

    try:
        assert process.stderr is not None
        for raw_line in process.stderr:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            stderr_tail.append(line)
            if len(stderr_tail) > 12:
                del stderr_tail[0]
            if line.startswith("time=") and on_progress:
                stamp = line.split("time=")[1].split(" ")[0]
                try:
                    hours, minutes, seconds = stamp.split(":")
                    elapsed = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
                except ValueError:
                    continue
                if duration > 0:
                    on_progress(max(0.0, min(1.0, elapsed / duration)), stage)
    finally:
        returncode = process.wait()
        if is_cancelled and is_cancelled():
            ffmpeg_utils.kill_process(process)

    if returncode != 0:
        detail = " | ".join(stderr_tail[-3:]) or f"exit code {returncode}"
        raise RuntimeError(f"FFmpeg failed: {detail}")


def render_clip(
    ctx: JobContext,
    source: str | Path,
    dest: str | Path,
    *,
    start: float,
    end: float,
    vertical_mode: str = "blur",
    captions: bool = False,
    srt_path: Path | None = None,
    source_size: tuple[int, int] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """Cut ``[start, end)`` from ``source`` into a vertical clip at ``dest``.

    ``on_progress(fraction, stage)`` is optional; without it the caller keeps
    whatever progress it had already reported.
    """
    source = Path(source)
    dest = Path(dest)
    ctx.check_cancelled()

    if not source.exists():
        raise FileNotFoundError(f"Source video not found: {source}")

    duration = max(0.5, end - start)
    if start < 0:
        raise ValueError("start must be >= 0")

    if source_size is None:
        info = ffmpeg_utils.probe(source)
        source_size = (info.width, info.height)
    src_w, src_h = source_size

    video_filter = build_video_filter(src_w, src_h, mode=vertical_mode)

    if captions and srt_path and srt_path.exists():
        subtitle_filter = build_subtitle_filter(srt_path)
        if subtitle_filter:
            video_filter = f"{video_filter},{subtitle_filter}"

    dest.parent.mkdir(parents=True, exist_ok=True)

    args = [
        "-y",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(source),
        "-vf",
        video_filter,
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        CLIP_PRESET,
        "-crf",
        str(CLIP_CRF),
        "-pix_fmt",
        "yuv420p",
        # Even dimensions keep H.264 happy on every player and on mobile Safari.
        "-profile:v",
        "high",
        "-level",
        "4.1",
        "-movflags",
        "+faststart",
    ]

    # Some sources have no audio track; muxing it unconditionally would fail.
    try:
        has_audio = ffmpeg_utils.probe(source).has_audio
    except Exception:  # noqa: BLE001
        has_audio = True
    if has_audio:
        args += ["-map", "0:a:0?", "-c:a", "aac", "-b:a", CLIP_AUDIO_BITRATE,
                 "-af", "aresample=async=1:first_pts=0"]

    args += [str(dest)]

    _run_with_progress(
        args,
        duration=duration,
        on_progress=(lambda fraction, label: on_progress(fraction, label))
        if on_progress
        else None,
        stage="Encoding clip",
        is_cancelled=ctx.is_cancelled,
    )

    if not dest.exists() or dest.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg produced no output for {dest.name}")

    return {
        "file_path": str(dest),
        "start": round(start, 2),
        "end": round(end, 2),
        "duration": round(duration, 2),
        "width": VERTICAL_WIDTH,
        "height": VERTICAL_HEIGHT,
        "size": dest.stat().st_size,
        "vertical_mode": vertical_mode,
        "has_captions": bool(captions and srt_path and srt_path.exists()),
    }


def render_thumbnail(ctx: JobContext, source: str | Path, dest: Path, at: float) -> str | None:
    """Grab a single frame for the gallery poster. Best-effort."""
    try:
        result = ffmpeg_utils.run_ffmpeg(
            [
                "-y",
                "-ss",
                f"{max(0.0, at):.3f}",
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-vf",
                f"scale={VERTICAL_WIDTH // 2}:-2:flags=lanczos",
                "-q:v",
                "4",
                str(dest),
            ],
            timeout=180,
        )
        if result.returncode == 0 and dest.exists():
            return dest.name
    except Exception:  # noqa: BLE001 - thumbnails are cosmetic
        pass
    return None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def generate_clips(
    ctx: JobContext,
    *,
    source: str | Path,
    video_id: str,
    transcript: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    count: int = 5,
    keywords: list[str] | None = None,
    min_seconds: float = CLIP_MIN_SECONDS,
    max_seconds: float = CLIP_MAX_SECONDS,
    target_seconds: float = CLIP_TARGET_SECONDS,
    vertical_mode: str = "blur",
    captions: bool = False,
) -> dict[str, Any]:
    """Select moments then render each one to a vertical clip."""
    source = Path(source)
    if not source.exists():
        raise FileNotFoundError(f"Source video not found: {source}")

    metadata = metadata or {}
    title = metadata.get("title") or f"YouTube video {video_id}"

    ctx.progress(3, "Analysing transcript")
    info = ffmpeg_utils.probe(source)
    duration = info.duration or float((transcript or {}).get("duration") or 0.0)
    if duration <= 0:
        raise RuntimeError("Could not determine the video duration.")

    effective_transcript = dict(transcript or {})
    effective_transcript.setdefault("duration", duration)

    picks = select_clips(
        effective_transcript,
        count=count,
        keywords=keywords,
        min_seconds=min_seconds,
        max_seconds=max_seconds,
        target_seconds=target_seconds,
    )
    if not picks:
        raise RuntimeError(
            "No clip candidates could be found. The video may be shorter than "
            f"{min_seconds:.0f}s or contain no usable audio."
        )

    ctx.log(f"Selected {len(picks)} moments to clip")
    for pick in picks:
        ctx.log(
            f"  #{pick['index']} {pick['start']:.1f}s-{pick['end']:.1f}s "
            f"({pick['duration']:.1f}s) score={pick['score']:.2f} "
            f"[{', '.join(pick.get('reasons') or []) or 'no signals'}]"
        )

    slug = _slugify(title)[:48].strip("-") or video_id
    records: list[dict[str, Any]] = []
    total = len(picks)

    for index, pick in enumerate(picks):
        ctx.check_cancelled()
        start = max(0.0, float(pick["start"]))
        end = min(duration, float(pick["end"]))
        if end - start < 3.0:
            continue

        base = 5 + (85 * index / max(1, total))
        span = 85 / max(1, total)
        ctx.progress(
            base,
            f"Rendering clip {index + 1}/{total} ({start:.0f}s-{end:.0f}s)",
        )

        clip_id = f"{video_id}_{index + 1:02d}_{int(start)}-{int(end)}"
        dest = CLIPS_DIR / f"{clip_id}.mp4"

        srt_path: Path | None = None
        if captions:
            cues = build_caption_cues(effective_transcript, start, end)
            if cues:
                srt_path = write_srt(cues, CLIPS_DIR / f"{clip_id}.srt")

        def report(fraction: float, label: str, _base=base, _span=span) -> None:
            ctx.progress(_base + max(0.0, min(1.0, fraction)) * _span, label)

        rendered = render_clip(
            ctx,
            source,
            dest,
            start=start,
            end=end,
            vertical_mode=vertical_mode,
            captions=captions,
            srt_path=srt_path,
            source_size=(info.width, info.height),
            on_progress=report,
        )

        poster = render_thumbnail(
            ctx, dest, CLIPS_DIR / f"{clip_id}.jpg", at=(end - start) / 2
        )

        record = {
            "id": clip_id,
            "index": int(pick.get("index") or (index + 1)),
            "video_id": video_id,
            "title": title,
            "uploader": metadata.get("uploader"),
            "thumbnail_url": metadata.get("thumbnail"),
            "filename": dest.name,
            "url": f"/static/clips/{dest.name}",
            "download_url": f"/api/clips/{clip_id}/download",
            "poster_url": f"/static/clips/{poster}" if poster else None,
            "start": rendered["start"],
            "end": rendered["end"],
            "duration": rendered["duration"],
            "width": rendered["width"],
            "height": rendered["height"],
            "aspect_ratio": "9:16",
            "format": "vertical",
            "vertical_mode": rendered["vertical_mode"],
            "captions": rendered["has_captions"],
            "size": rendered["size"],
            "score": pick.get("score", 0),
            "keywords": pick.get("keywords") or [],
            "reasons": pick.get("reasons") or [],
            "excerpt": (pick.get("text") or "")[:600],
            "created_at": time.time(),
        }
        records.append(record)
        ctx.log(
            f"Clip {index + 1}/{total} -> {dest.name} "
            f"({rendered['duration']:.1f}s, {rendered['size'] / 1e6:.1f} MB)"
        )

    if not records:
        raise RuntimeError("All clip candidates were too short to render.")

    merge_manifest(records)
    ctx.progress(100, f"Generated {len(records)} vertical clips")
    return {
        "video_id": video_id,
        "title": title,
        "vertical_mode": vertical_mode,
        "captions": captions,
        "clip_count": len(records),
        "clips": records,
    }


# ---------------------------------------------------------------------------
# Gallery manifest
# ---------------------------------------------------------------------------
def _slugify(value: str) -> str:
    value = re.sub(r"[^\w\s-]", "", value or "", flags=re.UNICODE).strip().lower()
    value = re.sub(r"[\s_-]+", "-", value)
    return re.sub(r"-{2,}", "-", value).strip("-")


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {"clips": [], "updated_at": None}
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"clips": [], "updated_at": None}
    if not isinstance(data, dict):
        return {"clips": [], "updated_at": None}
    data.setdefault("clips", [])
    return data


def save_manifest(data: dict[str, Any]) -> None:
    data["updated_at"] = time.time()
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def merge_manifest(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add records to the manifest, replacing any with the same id."""
    data = load_manifest()
    by_id = {clip["id"]: clip for clip in data.get("clips", []) if clip.get("id")}
    for record in records:
        by_id[record["id"]] = record
    merged = sorted(by_id.values(), key=lambda clip: clip.get("created_at", 0), reverse=True)
    data["clips"] = merged
    save_manifest(data)
    return merged


def list_clips(*, video_id: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
    clips = load_manifest().get("clips", [])
    # Drop entries whose file vanished (manual deletion, cleanup script).
    alive = [clip for clip in clips if (CLIPS_DIR / str(clip.get("filename", ""))).exists()]
    if video_id:
        alive = [clip for clip in alive if clip.get("video_id") == video_id]
    if limit:
        alive = alive[:limit]
    return alive


def delete_clip(clip_id: str) -> bool:
    data = load_manifest()
    clips = data.get("clips", [])
    match = next((clip for clip in clips if clip.get("id") == clip_id), None)
    if match is None:
        return False
    for suffix in (".mp4", ".jpg", ".srt"):
        candidate = CLIPS_DIR / f"{clip_id}{suffix}"
        if candidate.exists():
            candidate.unlink()
    data["clips"] = [clip for clip in clips if clip.get("id") != clip_id]
    save_manifest(data)
    return True