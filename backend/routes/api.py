"""Flask route definitions.

Endpoint surface
----------------
Ingest / pipeline
``POST   /api/download``          start a yt-dlp download          -> job
``GET    /api/download/<job_id>`` download job status
``POST   /api/transcribe``        start Whisper transcription     -> job
``GET    /api/transcribe/<job_id>``transcription job status
``POST   /api/clips``             select + render clips           -> job
``GET    /api/clips/job/<job_id>``clip job status
``GET    /api/transcript/<video_id>``   cached transcript

Jobs
``GET    /api/jobs``              recent jobs
``GET    /api/jobs/<job_id>``     snapshot status for any job type
``GET    /api/jobs/<job_id>/events``  Server-Sent Events progress stream
``POST   /api/jobs/<job_id>/cancel``  request cancellation
``POST   /api/jobs/<job_id>/retry``   resubmit a finished job

Review
``GET    /api/clips``             clip listing (optionally per video)
``GET    /api/clips/<clip_id>``   one clip
``PATCH  /api/clips/<clip_id>``   trim, keep/drop, retitle
``GET    /api/clips/<clip_id>/words``  word timings inside the clip
``GET    /api/clips/<clip_id>/srt``    caption sidecar
``POST   /api/clips/<clip_id>/render`` re-encode at a ratio/style -> job
``POST   /api/clips/render``      re-encode several clips at once -> job
``GET    /api/clips/<clip_id>/download``  force-download a clip
``DELETE /api/clips/<clip_id>``   delete a clip
``POST   /api/clips/clear``       delete every clip

Library
``GET    /api/projects``          every video held on disk, newest first
``GET    /api/projects/<video_id>``   one video with its counts
``GET    /api/library``           disk and content totals
``GET    /api/video/<video_id>``  cached video metadata
``DELETE /api/video/<video_id>``  delete a video and its clips

Settings / diagnostics
``GET    /api/settings``          persisted settings + available choices
``PUT    /api/settings``          update settings
``POST   /api/settings/reset``    restore defaults
``GET    /api/health``            ffmpeg / whisper / yt-dlp status

Every mutating endpoint that does real work is asynchronous: it returns a job id
immediately and the client follows it. The long-running stages (Whisper model
loading, FFmpeg encoding) would otherwise exceed browser and proxy timeouts.
"""

from __future__ import annotations

import json
import queue
import re
from pathlib import Path
from typing import Any

from flask import Blueprint, Response, jsonify, request, send_from_directory

from config import (
    ASPECT_RATIOS,
    CAPTION_STYLES,
    CLIP_MAX_SECONDS,
    CLIP_MIN_SECONDS,
    CLIP_TARGET_SECONDS,
    CLIPS_DIR,
    DEFAULT_ASPECT_RATIO,
    TRANSCRIPTS_DIR,
    VERTICAL_HEIGHT,
    VERTICAL_WIDTH,
)
from jobs import job_store
from services import clipper, downloader, ffmpeg_utils, projects, settings, transcriber

api = Blueprint("api", __name__, url_prefix="/api")

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# How long an SSE stream waits before emitting a comment frame to keep an
# otherwise-idle connection alive through a slow FFmpeg stage.
_SSE_KEEPALIVE_SECONDS = 15.0


def _error(message: str, status: int = 400, **extra: Any):
    payload = {"error": message, "ok": False}
    payload.update(extra)
    return jsonify(payload), status


def _bool_arg(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _int_arg(value: Any, default: int, *, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _float_arg(value: Any, default: float, *, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _keywords_arg(value: Any) -> list[str]:
    """Accept ``keywords`` as a list or a comma-separated string."""
    if value is None:
        return []
    if isinstance(value, str):
        parts: list[str] = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = [str(item) for item in value]
    else:
        return []
    return [part.strip() for part in parts if part.strip()][:30]


def _require_video_id(payload: dict[str, Any]) -> str | None:
    video_id = str(payload.get("video_id") or "").strip()
    return video_id if _VIDEO_ID_RE.match(video_id) else None


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------
@api.post("/download")
def start_download():
    payload = request.get_json(silent=True) or request.form.to_dict() or {}
    url = str(payload.get("url") or payload.get("video_url") or "").strip()
    if not url:
        return _error("Paste a YouTube URL first.")

    try:
        video_id = downloader.extract_video_id(url)
    except downloader.InvalidUrlError as exc:
        return _error(str(exc))

    force = _bool_arg(payload.get("force"), False)
    max_height = _int_arg(payload.get("max_height"), 1080, low=144, high=4320)

    def worker(ctx):
        metadata = downloader.download_video(
            ctx, url, max_height=max_height, force=force
        )
        return {"video": metadata}

    job = job_store.submit(
        "download",
        worker,
        params={"url": url, "video_id": video_id, "force": force,
                "max_height": max_height},
    )
    return jsonify({"ok": True, "job": job.to_dict(include_logs=False),
                    "video_id": video_id}), 202


@api.get("/download/<job_id>")
def download_status(job_id: str):
    return _job_response(job_id, "download")


# ---------------------------------------------------------------------------
# Transcribe
# ---------------------------------------------------------------------------
def _ensure_media(ctx, payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Resolve the media file + metadata for a transcript/clip request.

    Downloads on demand so ``/transcribe`` and ``/clips`` are usable as one-click
    operations straight from the UI.
    """
    video_id = _require_video_id(payload)
    if not video_id:
        raise ValueError("A valid video_id is required.")

    existing = downloader.find_existing_video(video_id)
    if existing is not None:
        ctx.progress(40, "Using downloaded video")
        sidecar = existing.with_suffix(".info.json")
        metadata: dict[str, Any] = {}
        if sidecar.exists():
            import json

            try:
                metadata = json.loads(sidecar.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                metadata = {}
        return str(existing), metadata or {"video_id": video_id,
                                           "title": f"YouTube video {video_id}"}

    url = payload.get("url") or downloader.canonical_url(video_id)
    metadata = downloader.download_video(ctx, url)
    return str(metadata["file_path"]), metadata


@api.post("/transcribe")
def start_transcribe():
    payload = request.get_json(silent=True) or request.form.to_dict() or {}
    video_id = _require_video_id(payload)
    if not video_id:
        url = str(payload.get("url") or "").strip()
        if not url:
            return _error("Provide a video_id or a YouTube URL.")
        try:
            video_id = downloader.extract_video_id(url)
        except downloader.InvalidUrlError as exc:
            return _error(str(exc))
    payload = {**payload, "video_id": video_id}

    language = str(payload.get("language") or "").strip() or None
    model_name = str(payload.get("model") or "").strip() or None
    force = _bool_arg(payload.get("force"), False)

    def worker(ctx):
        media_path, metadata = _ensure_media(ctx, payload)
        transcript = transcriber.transcribe_media(
            ctx,
            media_path,
            video_id=video_id,
            language=language,
            model_name=model_name,
            include_words=_bool_arg(payload.get("include_words"), True),
            force=force,
        )
        return {"transcript": transcript, "video": metadata}

    job = job_store.submit(
        "transcribe",
        worker,
        params={"video_id": video_id, "language": language, "model": model_name,
                "force": force},
    )
    return jsonify({"ok": True, "job": job.to_dict(include_logs=False),
                    "video_id": video_id}), 202


@api.get("/transcribe/<job_id>")
def transcribe_status(job_id: str):
    return _job_response(job_id, "transcribe")


@api.get("/transcript/<video_id>")
def get_transcript(video_id: str):
    if not _VIDEO_ID_RE.match(video_id):
        return _error("Invalid video id.")
    transcript = transcriber.load_transcript(video_id)
    if transcript is None:
        return _error("No transcript cached for that video.", 404)
    return jsonify({"ok": True, "transcript": transcript})


# ---------------------------------------------------------------------------
# Clips
# ---------------------------------------------------------------------------
@api.post("/clips")
def start_clips():
    payload = request.get_json(silent=True) or request.form.to_dict() or {}
    video_id = _require_video_id(payload)
    if not video_id:
        url = str(payload.get("url") or "").strip()
        if not url:
            return _error("Provide a video_id or a YouTube URL.")
        try:
            video_id = downloader.extract_video_id(url)
        except downloader.InvalidUrlError as exc:
            return _error(str(exc))
    payload = {**payload, "video_id": video_id}

    count = _int_arg(payload.get("count"), 5, low=1, high=30)
    keywords = _keywords_arg(payload.get("keywords"))
    min_seconds = _float_arg(payload.get("min_seconds"), CLIP_MIN_SECONDS,
                             low=5.0, high=600.0)
    max_seconds = _float_arg(payload.get("max_seconds"), CLIP_MAX_SECONDS,
                             low=min_seconds, high=1800.0)
    target_seconds = _float_arg(payload.get("target_seconds"), CLIP_TARGET_SECONDS,
                                low=min_seconds, high=max_seconds)
    vertical_mode = str(payload.get("vertical_mode") or "blur").lower()
    if vertical_mode not in {"crop", "blur", "fit"}:
        return _error("vertical_mode must be one of: crop, blur, fit")
    captions = _bool_arg(payload.get("captions"), True)
    auto_transcribe = _bool_arg(payload.get("auto_transcribe"), True)
    model_name = str(payload.get("model") or "").strip() or None

    def worker(ctx):
        media_path, metadata = _ensure_media(ctx, payload)

        transcript = transcriber.load_transcript(video_id)
        if transcript is None and auto_transcribe:
            ctx.log("No transcript found - transcribing first")
            transcript = transcriber.transcribe_media(
                ctx, media_path, video_id=video_id, model_name=model_name
            )
        elif transcript is not None:
            ctx.log("Reusing cached transcript")

        return clipper.generate_clips(
            ctx,
            source=media_path,
            video_id=video_id,
            transcript=transcript,
            metadata=metadata,
            count=count,
            keywords=keywords,
            min_seconds=min_seconds,
            max_seconds=max_seconds,
            target_seconds=target_seconds,
            vertical_mode=vertical_mode,
            captions=captions,
        )

    job = job_store.submit(
        "clips",
        worker,
        params={
            "video_id": video_id,
            "count": count,
            "keywords": keywords,
            "min_seconds": min_seconds,
            "max_seconds": max_seconds,
            "target_seconds": target_seconds,
            "vertical_mode": vertical_mode,
            "captions": captions,
        },
    )
    return jsonify({"ok": True, "job": job.to_dict(include_logs=False),
                    "video_id": video_id}), 202


@api.get("/clips")
def list_clips():
    video_id = request.args.get("video_id") or None
    limit = request.args.get("limit")
    clips = clipper.list_clips(
        video_id=video_id,
        limit=_int_arg(limit, 0, low=0, high=500) if limit else None,
    )
    return jsonify({
        "ok": True,
        "count": len(clips),
        "clips": clips,
        "clips_dir": str(CLIPS_DIR),
        "output": {
            "width": VERTICAL_WIDTH,
            "height": VERTICAL_HEIGHT,
            "aspect_ratio": "9:16",
        },
    })


@api.get("/clips/job/<job_id>")
def clips_job_status(job_id: str):
    return _job_response(job_id, "clips")


@api.get("/clips/<clip_id>")
def get_clip(clip_id: str):
    clip = clipper.get_clip(clip_id)
    if clip is None:
        return _error("Unknown clip.", 404)
    return jsonify({"ok": True, "clip": clip})


@api.patch("/clips/<clip_id>")
def patch_clip(clip_id: str):
    """Trim, keep/drop, or retitle a clip.

    Deliberately does not re-encode: dragging a trim handle should feel
    instant, and the encode is a separate, slower step the client asks for
    explicitly once the cut is settled.
    """
    payload = request.get_json(silent=True) or request.form.to_dict() or {}

    start = payload.get("start", payload.get("start_s"))
    end = payload.get("end", payload.get("end_s"))
    if start is not None:
        start = _float_arg(start, None, low=0.0, high=86400.0)
    if end is not None:
        end = _float_arg(end, None, low=0.0, high=86400.0)

    try:
        clip = clipper.update_clip(
            clip_id,
            status=payload.get("status"),
            start=start,
            end=end,
            title=payload.get("title"),
        )
    except ValueError as exc:
        return _error(str(exc))

    if clip is None:
        return _error("Unknown clip.", 404)
    projects.invalidate()
    return jsonify({"ok": True, "clip": clip})


@api.get("/clips/<clip_id>/words")
def clip_words(clip_id: str):
    """Word timings inside the clip, relative to its start.

    Drives the trim bar and the caption editor. A clip with no transcript simply
    has no words, which is a valid answer rather than an error.
    """
    if clipper.get_clip(clip_id) is None:
        return _error("Unknown clip.", 404)
    return jsonify({"ok": True, "words": clipper.clip_words(clip_id)})


@api.get("/clips/<clip_id>/srt")
def clip_srt(clip_id: str):
    if clipper.get_clip(clip_id) is None:
        return _error("Unknown clip.", 404)
    path = CLIPS_DIR / f"{clip_id}.srt"
    if not path.exists():
        return _error("No caption file has been written for this clip.", 404)
    return Response(
        path.read_text(encoding="utf-8"),
        mimetype="application/x-subrip",
        headers={"Content-Disposition": f'attachment; filename="{clip_id}.srt"'},
    )


@api.post("/clips/<clip_id>/subtitle")
def upload_clip_subtitle(clip_id: str):
    """Upload a custom subtitle file for a clip.

    Accepts an SRT file under the field name ``subtitle``. The file is written
    next to the clip as ``{clip_id}.srt`` and the manifest is updated so the
    review screen can offer it for download.
    """
    if clipper.get_clip(clip_id) is None:
        return _error("Unknown clip.", 404)

    uploaded = request.files.get("subtitle")
    if not uploaded or uploaded.filename == "":
        return _error("Upload a subtitle file under the field name 'subtitle'.")

    filename = uploaded.filename.lower()
    if not filename.endswith(".srt"):
        return _error("Only .srt subtitle files are supported.")

    destination = CLIPS_DIR / f"{clip_id}.srt"
    uploaded.save(str(destination))

    # Update manifest so the review screen knows captions are present.
    clips = clipper.load_manifest().get("clips", [])
    updated = False
    for clip in clips:
        if clip.get("id") == clip_id:
            clip["captions"] = True
            clip["has_captions"] = True
            updated = True
            break
    if updated:
        clipper.save_manifest({"clips": clips})

    return jsonify({"ok": True, "clip_id": clip_id, "subtitle": destination.name})


def _render_worker(clip_ids: list[str], options: dict[str, Any]):
    """Shared worker for single and batch re-renders."""

    def worker(ctx):
        rendered: list[dict[str, Any]] = []
        failures: list[dict[str, str]] = []
        total = max(1, len(clip_ids))
        for index, clip_id in enumerate(clip_ids):
            ctx.check_cancelled()
            ctx.progress(
                100 * index / total,
                f"Rendering {index + 1}/{total}",
            )
            try:
                clip = clipper.rerender_clip(ctx, clip_id, **options)
                rendered.append(clip)
            except (FileNotFoundError, ValueError) as exc:
                # One bad clip must not abandon the rest of the batch; the
                # failures come back alongside whatever did render.
                failures.append({"clip_id": clip_id, "error": str(exc)})
                ctx.log(f"{clip_id}: {exc}", "error")
        ctx.progress(100, f"Rendered {len(rendered)}/{total} clips")
        return {"rendered": rendered, "failed": failures, "count": len(rendered)}

    return worker


@api.post("/clips/<clip_id>/render")
def render_clip(clip_id: str):
    if clipper.get_clip(clip_id) is None:
        return _error("Unknown clip.", 404)
    payload = request.get_json(silent=True) or request.form.to_dict() or {}

    options: dict[str, Any] = {}
    ratio = str(payload.get("aspect_ratio") or payload.get("ratio") or "").strip()
    if ratio:
        if ratio not in ASPECT_RATIOS:
            return _error(f"aspect_ratio must be one of: {', '.join(ASPECT_RATIOS)}")
        options["aspect_ratio"] = ratio
    style = str(payload.get("caption_style") or "").strip()
    if style:
        if style not in CAPTION_STYLES:
            return _error(f"caption_style must be one of: {', '.join(CAPTION_STYLES)}")
        options["caption_style_key"] = style
    if "captions" in payload:
        options["captions"] = _bool_arg(payload.get("captions"), True)

    job = job_store.submit(
        "render",
        _render_worker([clip_id], options),
        params={"clip_ids": [clip_id], **options},
    )
    return jsonify({"ok": True, "job": job.to_dict(include_logs=False)}), 202


@api.post("/clips/render")
def render_clips_batch():
    """Re-encode several clips in one job. Defaults to every kept clip."""
    payload = request.get_json(silent=True) or request.form.to_dict() or {}

    if payload.get("clip_ids"):
        raw = payload["clip_ids"]
        if isinstance(raw, str):
            clip_ids = [part.strip() for part in raw.split(",") if part.strip()]
        elif isinstance(raw, (list, tuple)):
            clip_ids = [str(item).strip() for item in raw if str(item).strip()]
        else:
            clip_ids = []
    else:
        status = str(payload.get("status") or "kept").strip().lower()
        wanted = {status} if status in clipper.CLIP_STATUSES else set(clipper.CLIP_STATUSES)
        clip_ids = [
            str(clip["id"])
            for clip in clipper.list_clips()
            if str(clip.get("status") or "candidate") in wanted
        ]

    clip_ids = clip_ids[:50]
    if not clip_ids:
        return _error("No clips matched that request.", 404)

    options: dict[str, Any] = {}
    ratio = str(payload.get("aspect_ratio") or payload.get("ratio") or "").strip()
    if ratio:
        if ratio not in ASPECT_RATIOS:
            return _error(f"aspect_ratio must be one of: {', '.join(ASPECT_RATIOS)}")
        options["aspect_ratio"] = ratio
    style = str(payload.get("caption_style") or "").strip()
    if style:
        if style not in CAPTION_STYLES:
            return _error(f"caption_style must be one of: {', '.join(CAPTION_STYLES)}")
        options["caption_style_key"] = style
    if "captions" in payload:
        options["captions"] = _bool_arg(payload.get("captions"), True)

    job = job_store.submit(
        "render",
        _render_worker(clip_ids, options),
        params={"clip_ids": clip_ids, **options},
    )
    return jsonify({
        "ok": True,
        "job": job.to_dict(include_logs=False),
        "clip_ids": clip_ids,
    }), 202


@api.get("/clips/<clip_id>/download")
def download_clip(clip_id: str):
    clip = next(
        (c for c in clipper.list_clips() if c.get("id") == clip_id), None
    )
    if clip is None:
        return _error("Unknown clip.", 404)
    path = CLIPS_DIR / str(clip.get("filename", ""))
    if not path.exists():
        return _error("Clip file is missing from disk.", 404)
    safe_title = re.sub(r"[^\w\-. ]", "", clip.get("title") or clip_id).strip()
    filename = f"{safe_title or clip_id}_{clip.get('start', 0):.0f}s.mp4"
    response = send_from_directory(
        CLIPS_DIR, path.name, as_attachment=True, download_name=filename
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@api.delete("/clips/<clip_id>")
def remove_clip(clip_id: str):
    if not clipper.delete_clip(clip_id):
        return _error("Unknown clip.", 404)
    return jsonify({"ok": True, "deleted": clip_id})


@api.post("/clips/clear")
def clear_clips():
    removed = 0
    for clip in clipper.list_clips():
        if clipper.delete_clip(str(clip.get("id"))):
            removed += 1
    return jsonify({"ok": True, "deleted": removed})


# ---------------------------------------------------------------------------
# Videos
# ---------------------------------------------------------------------------
@api.get("/video/<video_id>")
def get_video(video_id: str):
    if not _VIDEO_ID_RE.match(video_id):
        return _error("Invalid video id.")
    media = downloader.find_existing_video(video_id)
    if media is None:
        return _error("That video has not been downloaded yet.", 404)

    import json

    sidecar = media.with_suffix(".info.json")
    metadata: dict[str, Any] = {}
    if sidecar.exists():
        try:
            metadata = json.loads(sidecar.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            metadata = {}
    metadata.setdefault("video_id", video_id)
    metadata.setdefault("file_path", str(media))
    metadata["downloaded"] = True
    metadata["has_transcript"] = transcriber.transcript_file(video_id).exists()
    return jsonify({"ok": True, "video": metadata})


@api.delete("/video/<video_id>")
def remove_video(video_id: str):
    if not _VIDEO_ID_RE.match(video_id):
        return _error("Invalid video id.")
    downloader.delete_video_files(video_id)
    return jsonify({"ok": True, "deleted": video_id})


@api.get("/transcripts")
def list_transcripts():
    records = []
    for path in sorted(TRANSCRIPTS_DIR.glob("*.json")):
        records.append({
            "video_id": path.stem,
            "size": path.stat().st_size,
            "modified_at": path.stat().st_mtime,
        })
    return jsonify({"ok": True, "transcripts": records})


# ---------------------------------------------------------------------------
# Projects / library
#
# The index of what is actually on disk. Without it the only route back to a
# previous video is pasting its id into the form again.
# ---------------------------------------------------------------------------
@api.get("/projects")
def list_projects():
    include_empty = not _bool_arg(request.args.get("empty"), False)
    records = projects.list_projects(include_empty=include_empty)
    return jsonify({"ok": True, "count": len(records), "projects": records})


@api.get("/projects/<video_id>")
def get_project(video_id: str):
    if not _VIDEO_ID_RE.match(video_id):
        return _error("Invalid video id.")
    record = projects.get_project(video_id)
    if record is None:
        return _error("Nothing on disk for that video.", 404)
    clips = clipper.list_clips(video_id=video_id)
    return jsonify({"ok": True, "project": record, "clips": clips})


@api.get("/library")
def library():
    return jsonify({"ok": True, "summary": projects.library_summary()})


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@api.get("/settings")
def get_settings():
    return jsonify({"ok": True, **settings.public()})


@api.put("/settings")
def put_settings():
    """Partial update. Unknown keys are ignored and bad values are clamped."""
    payload = request.get_json(silent=True) or request.form.to_dict() or {}
    return jsonify({"ok": True, "settings": settings.save(payload)})


@api.post("/settings/reset")
def reset_settings():
    settings.reset()
    return jsonify({"ok": True, "settings": settings.load()})


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
def _job_response(job_id: str, expected_type: str | None = None):
    job = job_store.get(job_id)
    if job is None:
        return _error("Unknown job id.", 404)
    if expected_type and job.type != expected_type:
        return _error(f"Job {job_id} is a {job.type} job, not {expected_type}.", 400)
    return jsonify({"ok": True, "job": job.to_dict()})


@api.get("/jobs/<job_id>")
def get_job(job_id: str):
    return _job_response(job_id)


@api.get("/jobs/<job_id>/events")
def job_events(job_id: str):
    """Stream a job's progress as Server-Sent Events.

    Preferred over polling on the progress screen: a render reports progress
    several times a second, and a poll at any human-visible cadence leaves the
    bar visibly stuck between updates.

    Each connection gets a snapshot on open, so a client that connects halfway
    through a long job renders immediately instead of waiting for the next tick.
    A comment frame every ``_SSE_KEEPALIVE_SECONDS`` keeps intermediaries from
    closing an idle connection during a slow FFmpeg stage.

    Note: the Flask dev server is threaded, so each open stream holds a thread.
    That is fine for a single-operator local tool; behind a real WSGI server,
    confirm the worker class is threaded or the streams will serialise.
    """
    job = job_store.get(job_id)
    if job is None:
        return _error("Unknown job id.", 404)

    sink = job.subscribe()

    def stream():
        try:
            yield ": stream open\n\n"
            while True:
                try:
                    message = sink.get(timeout=_SSE_KEEPALIVE_SECONDS)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue

                payload = {k: v for k, v in message.items() if k != "event"}
                yield (
                    f"event: {message['event']}\n"
                    f"data: {json.dumps(payload, default=str)}\n\n"
                )

                if message["event"] in {"succeeded", "failed", "cancelled"}:
                    break
        except GeneratorExit:
            # Client navigated away or closed the tab. Unhook so the job stops
            # fanning out to a queue nobody reads.
            raise
        finally:
            job.unsubscribe(sink)

    response = Response(stream(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache, no-transform"
    response.headers["Connection"] = "keep-alive"
    # Tell any reverse proxy not to buffer, which would defeat the point.
    response.headers["X-Accel-Buffering"] = "no"
    return response


@api.post("/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    if not job_store.cancel(job_id):
        return _error("Job not found or already finished.", 404)
    return jsonify({"ok": True, "cancelling": job_id})


@api.post("/jobs/<job_id>/retry")
def retry_job(job_id: str):
    """Resubmit a finished job's worker as a new job.

    Returns the new job so the client can navigate to its progress page. A job
    that is still running, or whose worker is no longer in memory, cannot be
    retried -- in both cases the honest answer is to submit the request again.
    """
    existing = job_store.get(job_id)
    if existing is None:
        return _error("Unknown job id.", 404)

    job = job_store.retry(job_id)
    if job is None:
        return _error(
            "This job cannot be retried automatically. It is either still "
            "running or too old to still hold its work.",
            409,
        )
    return jsonify({"ok": True, "job": job.to_dict(include_logs=False),
                    "job_id": job.id, "previous_job_id": job_id}), 202


@api.get("/jobs")
def list_jobs():
    jobs = [job.to_dict(include_logs=False) for job in job_store.list()]
    return jsonify({"ok": True, "jobs": jobs})


# ---------------------------------------------------------------------------
# Diagnostics / misc
# ---------------------------------------------------------------------------
@api.get("/health")
def health():
    ffmpeg_report = ffmpeg_utils.availability()

    whisper_report: dict[str, Any] = {"ok": False, "backend": None,
                                      "model": None, "error": None}
    try:
        import torch
        import whisper  # noqa: F401

        whisper_report.update(
            {
                "ok": True,
                "backend": "faster-whisper" if transcriber._faster_whisper_available()
                else "openai-whisper",
                "model": transcriber.WHISPER_MODEL,
                "torch": torch.__version__,
                "cuda": bool(torch.cuda.is_available()),
                "device": transcriber._resolve_device(),
            }
        )
    except Exception as exc:  # noqa: BLE001
        whisper_report["error"] = f"{type(exc).__name__}: {exc}"

    ytdlp_version = None
    try:
        import yt_dlp

        ytdlp_version = yt_dlp.version.__version__
    except Exception:  # noqa: BLE001
        pass

    return jsonify({
        "ok": True,
        "ffmpeg": ffmpeg_report["ffmpeg"],
        "ffmpeg_shim": ffmpeg_report["shim"],
        "ffprobe": ffmpeg_report["ffprobe"],
        "whisper": whisper_report,
        "ytdlp_version": ytdlp_version,
        "clips_dir": str(CLIPS_DIR),
        "clips_on_disk": len(list(CLIPS_DIR.glob("*.mp4"))),
        "output": {"width": VERTICAL_WIDTH, "height": VERTICAL_HEIGHT,
                   "aspect_ratio": "9:16"},
        "limits": {"min_clip_seconds": CLIP_MIN_SECONDS,
                   "max_clip_seconds": CLIP_MAX_SECONDS,
                   "target_clip_seconds": CLIP_TARGET_SECONDS},
        "whisper_models": transcriber.model_catalog(),
    })


@api.post("/models/unload")
def unload_models():
    transcriber.unload_models()
    return jsonify({"ok": True, "unloaded": True})


@api.get("/config")
def public_config():
    """Defaults for a cold client.

    Superseded by ``GET /api/settings``, which returns the operator's saved
    preferences. Kept because it is the cheaper call and the one a script wants.
    """
    saved = settings.load()
    return jsonify({
        "ok": True,
        "defaults": {
            "clip_count": saved["clip_count"],
            "clip_min_seconds": saved["min_seconds"],
            "clip_max_seconds": saved["max_seconds"],
            "clip_target_seconds": saved["target_seconds"],
            "vertical_modes": list(settings.VERTICAL_MODE_CHOICES),
            "vertical_mode": saved["vertical_mode"],
            "output": {"width": VERTICAL_WIDTH, "height": VERTICAL_HEIGHT},
            "aspect_ratios": list(settings.ASPECT_CHOICES),
            "aspect_ratio": saved["aspect_ratio"],
            "caption_styles": clipper.caption_style_catalog(),
            "whisper_model": saved["whisper_model"],
            "captions": saved["captions"],
        },
    })


def register_routes(app) -> None:
    app.register_blueprint(api)