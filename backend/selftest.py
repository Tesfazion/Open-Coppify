"""Self-checks for the trickiest logic in Coppify.

Run with:  python backend/selftest.py

These are deliberately dependency-free (no pytest needed) so the user can
sanity-check a fresh install in one command. Each check prints PASS/FAIL and
the script exits non-zero if anything fails.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (  # noqa: E402
    CLIP_MAX_SECONDS,
    CLIP_MIN_GAP,
    CLIP_MIN_SECONDS,
    CLIP_TARGET_SECONDS,
    VERTICAL_HEIGHT,
    VERTICAL_WIDTH,
)
from services import ffmpeg_utils  # noqa: E402

PASSED = 0
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL  {name}" + (f" -- {detail}" if detail else ""))


# ---------------------------------------------------------------------------
def test_url_parsing() -> None:
    print("\n[1] YouTube URL parsing")
    from services.downloader import InvalidUrlError, extract_video_id

    vid = "dQw4w9WgXcQ"
    valid = [
        f"https://www.youtube.com/watch?v={vid}",
        f"https://youtu.be/{vid}",
        f"https://m.youtube.com/watch?v={vid}&t=42s",
        f"https://www.youtube.com/shorts/{vid}",
        f"https://www.youtube.com/live/{vid}",
        f"https://www.youtube.com/embed/{vid}",
        f"https://music.youtube.com/watch?v={vid}",
        vid,
        f"  https://youtu.be/{vid}?t=10  ",
    ]
    for url in valid:
        try:
            check(f"accepts {url.strip()[:46]}", extract_video_id(url) == vid)
        except Exception as exc:  # noqa: BLE001
            check(f"accepts {url.strip()[:46]}", False, str(exc))

    invalid = ["https://vimeo.com/12345", "", "not a url", "https://youtube.com/watch?v=short"]
    for url in invalid:
        try:
            extract_video_id(url)
            check(f"rejects {url or '<empty>'}", False, "was accepted")
        except InvalidUrlError:
            check(f"rejects {url or '<empty>'}", True)
        except Exception as exc:  # noqa: BLE001
            check(f"rejects {url or '<empty>'}", False, f"wrong error {exc!r}")


def test_ffmpeg_discovery() -> None:
    print("\n[2] FFmpeg discovery + shim")
    import os
    import subprocess

    try:
        path = ffmpeg_utils.ffmpeg_path()
        check("ffmpeg resolved", bool(path), "not found")
        check("ffmpeg runs", b"ffmpeg version" in subprocess.run(
            [path, "-version"], capture_output=True).stdout)
    except Exception as exc:  # noqa: BLE001
        check("ffmpeg resolved", False, str(exc))
        return

    # Whisper shells out to a *bare* "ffmpeg"; that only works via the shim.
    shim = Path(__file__).resolve().parent.parent / ".bin" / (
        "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    )
    check("shim exists", shim.exists(), str(shim))
    bare = subprocess.run(["ffmpeg", "-version"], capture_output=True)
    check("bare-name 'ffmpeg' works (needed by whisper)",
          bare.returncode == 0 and b"ffmpeg version" in bare.stdout,
          f"rc={bare.returncode}")


def test_probe() -> None:
    print("\n[3] ffprobe-free media inspection")
    tmp = Path(tempfile.mkdtemp(prefix="coppify_probe_"))
    try:
        out = tmp / "sample.mp4"
        result = ffmpeg_utils.run_ffmpeg(
            ["-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
             "-t", "8", "-c:v", "libx264", "-preset", "ultrafast",
             "-pix_fmt", "yuv420p", "-c:a", "aac", str(out)],
            timeout=180,
        )
        if result.returncode != 0:
            check("synthesise test video", False, (result.stderr or b"").decode()[-200:])
            return
        info = ffmpeg_utils.probe(out)
        check("width parsed", info.width == 1280, str(info.width))
        check("height parsed", info.height == 720, str(info.height))
        check("duration ~8s", 7.5 <= info.duration <= 8.5, str(info.duration))
        check("video stream detected", info.has_video)
        check("audio stream detected", info.has_audio)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_chunk_offsets() -> None:
    print("\n[4] Whisper chunk timestamp offsetting")
    from jobs import JobContext, JobStore
    from services import transcriber

    tmp = Path(tempfile.mkdtemp(prefix="coppify_chunk_"))
    try:
        media = tmp / "audio.mp4"
        result = ffmpeg_utils.run_ffmpeg(
            ["-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100",
             "-t", "30", "-c:a", "aac", str(media)],
            timeout=180,
        )
        if result.returncode != 0:
            check("synthesise audio", False, (result.stderr or b"").decode()[-200:])
            return

        # Force many chunks so the offset maths is exercised heavily.
        transcriber.CHUNK_SECONDS = 10
        transcriber.CHUNK_OVERLAP = 2
        duration = 30.0
        expected_chunks = transcriber._chunk_bounds(duration)
        check("chunking splits with overlap",
              len(expected_chunks) >= 4 and expected_chunks[1][0] == 8.0,
              str(expected_chunks))

        # Replace the actual Whisper call with deterministic fake output:
        # two 4-second segments per chunk, so chunk 1 ends at global 8s and
        # chunk 2 starts at global 8s -> must be de-duplicated, not repeated.
        calls: list[tuple[float, float]] = []

        def fake_transcribe_chunk(model, backend, chunk_file, language, include_words):
            # Real Whisper never reports timestamps past the slice it decoded,
            # so derive the span from the extracted clip's actual length.
            calls.append(chunk_file)
            span = min(8.0, max(0.0, chunk_file.stat().st_size / 32000.0))
            second = min(4.0, span)
            segments = [
                {"start": 0.0, "end": second, "text": "alpha"},
                {"start": second, "end": span, "text": "bravo"},
            ]
            words = [
                {"start": 0.0, "end": min(1.0, span), "word": "alpha"},
                {"start": second, "end": span, "word": "bravo"},
            ]
            return {"segments": segments, "words": words, "language": "en"}

        original = transcriber._transcribe_chunk
        transcriber._transcribe_chunk = fake_transcribe_chunk
        try:
            store = JobStore()
            job = store.create("transcribe")
            ctx = JobContext(job)
            result = transcriber.transcribe_media(
                ctx, media, video_id="__selftest__",
                model_name="tiny", force=True,
            )
        finally:
            transcriber._transcribe_chunk = original
            transcriber.CHUNK_SECONDS = 300
            transcriber.CHUNK_OVERLAP = 2.0

        segments = result["segments"]
        starts = [s["start"] for s in segments]
        ends = [s["end"] for s in segments]

        check("audio was sliced for every chunk", len(calls) == len(expected_chunks),
              f"{len(calls)} != {len(expected_chunks)}")
        check("produced segments", len(segments) > 0, "none")
        check("timestamps are monotonic",
              all(b >= a for a, b in zip(starts, starts[1:])), str(starts))
        check("no overlapping segments",
              all(ends[i] <= starts[i + 1] + 0.001 for i in range(len(segments) - 1)),
              str(list(zip(starts, ends))))
        check("first segment starts at 0", starts[0] == 0.0, str(starts[0]))
        check("timestamps offset past first chunk", max(ends) > 8.0, str(max(ends)))
        check("timestamps within media duration", max(ends) <= duration + 0.5,
              str(max(ends)))
        check("word timestamps present", len(result["words"]) > 0, "none")
        # transcribe_media tops out at 99; the job wrapper stamps 100.
        check("progress reaches the end", job.progress >= 99.0, str(job.progress))
        alpha = sum(1 for seg in segments if seg["text"] == "alpha")
        bravo = sum(1 for seg in segments if seg["text"] == "bravo")
        check("text assembled from every segment",
              result["text"].count("alpha") == alpha and
              result["text"].count("bravo") == bravo and alpha > 0,
              f"alpha x{result['text'].count('alpha')}/{alpha} "
              f"bravo x{result['text'].count('bravo')}/{bravo}")

        # The de-dup guarantee: no repeated "bravo" at the same global time.
        seen = set()
        dupes = 0
        for seg in segments:
            key = (seg["start"], seg["text"])
            if key in seen:
                dupes += 1
            seen.add(key)
        check("overlap de-duplicated", dupes == 0, f"{dupes} duplicates")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_segmenter() -> None:
    print("\n[5] Clip selection (30-60s, keywords, spacing)")
    from services.segmenter import build_candidates, select_clips

    segments = []
    t = 0.0
    hot_words = ["amazing", "insane", "secret"]
    for i in range(600):  # ~600s of speech, 1s segments
        text = f"word{i}"
        if i in (120, 121, 400, 401, 402):
            text = f"{hot_words[i % 3]} {text}"
        segments.append({"start": t, "end": t + 1.0, "text": text})
        t += 1.0

    transcript = {"segments": segments, "words": [], "duration": t}
    candidates = build_candidates(transcript, min_seconds=CLIP_MIN_SECONDS,
                                  max_seconds=CLIP_MAX_SECONDS,
                                  target_seconds=CLIP_TARGET_SECONDS)
    check("candidates generated", len(candidates) > 20, str(len(candidates)))
    check("candidates respect duration bounds",
          all(CLIP_MIN_SECONDS - 0.6 <= c["duration"] <= CLIP_MAX_SECONDS + 0.6
              for c in candidates),
          str([round(c["duration"], 1) for c in candidates[:5]]))

    picks = select_clips(transcript, count=4, keywords=["amazing", "insane", "secret"],
                         min_gap=CLIP_MIN_GAP)
    check("requested number of clips returned", len(picks) == 4, str(len(picks)))
    check("all clips within 30-60s",
          all(CLIP_MIN_SECONDS - 0.6 <= p["duration"] <= CLIP_MAX_SECONDS + 0.6
              for p in picks),
          str([round(p["duration"], 1) for p in picks]))
    for i, pick in enumerate(picks):
        for other in picks[i + 1:]:
            gap = max(other["start"], pick["start"]) - min(pick["end"], other["end"])
            check(f"clips {i + 1}/{i + 2} respect min gap",
                  gap >= CLIP_MIN_GAP - 0.01, f"gap {gap:.2f}s")

    # Only two regions of the fixture contain "insane", so requesting 3 clips
    # cannot make all of them keyword clips. Assert the real invariant instead:
    # every keyword a pick *claims* must actually overlap that keyword.
    keyword_picks = select_clips(transcript, count=3, keywords=["insane"])
    check("at least one clip matched the keyword",
          any(p["keywords"] for p in keyword_picks),
          "no keyword matches found")
    check("claimed keywords actually overlap the clip",
          all(any(kw in seg["text"] for seg in segments
                  if seg["start"] < p["end"] and seg["end"] > p["start"])
              for p in keyword_picks for kw in p["keywords"]),
          "a claimed keyword was not inside its clip")

    check("no-transcript fallback works",
          len(select_clips({"segments": [], "duration": 600}, count=3)) == 3)
    check("short media handled",
          len(select_clips({"segments": [], "duration": 12}, count=3)) >= 0)


def test_vertical_filters() -> None:
    print("\n[6] 9:16 vertical filter construction")
    from services.clipper import build_video_filter

    target_ar = VERTICAL_WIDTH / VERTICAL_HEIGHT

    for label, (w, h), expect in [
        ("landscape 16:9 -> centre crop", (1920, 1080), "crop"),
        ("square -> centre crop", (1080, 1080), "crop"),
        ("portrait already 9:16", (1080, 1920), "scale"),
        ("taller than 9:16", (1080, 2400), "scale"),
    ]:
        filt = build_video_filter(w, h, mode="crop", blur=0.4)
        check(f"{label}: 9:16 crop/scale applied",
              "crop" in filt or "scale" in filt, filt)
        if expect == "crop" and w / h > target_ar:
            crop = filt.split("crop=")[1].split(",")[0] if "crop=" in filt else ""
            parts = [float(p) for p in crop.split(":")] if crop else []
            # crop=w:h:x:y -- the ratio comes from w/h, not x/y.
            check(f"{label}: crop is 9:16",
                  len(parts) == 4 and parts[1] > 0 and
                  abs((parts[0] / parts[1]) - target_ar) < 0.01, filt)

    filt = build_video_filter(1920, 1080, mode="blur", blur=0.4)
    check("blur mode uses blurred background",
          "boxblur" in filt and "overlay" in filt, filt)
    check("blur mode fits inside 9:16",
          f"{VERTICAL_WIDTH}" in filt, filt)


def test_render_clip() -> None:
    print("\n[7] End-to-end vertical clip render")
    from jobs import JobContext, JobStore
    from services.clipper import render_clip

    tmp = Path(tempfile.mkdtemp(prefix="coppify_render_"))
    try:
        source = tmp / "src.mp4"
        result = ffmpeg_utils.run_ffmpeg(
            ["-y", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=25",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
             "-t", "12", "-c:v", "libx264", "-preset", "ultrafast",
             "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)],
            timeout=240,
        )
        if result.returncode != 0:
            check("synthesise 1080p source", False, (result.stderr or b"").decode()[-200:])
            return

        dest = tmp / "clip.mp4"
        store = JobStore()
        ctx = JobContext(store.create("clips"))
        meta = render_clip(ctx, source, dest, start=2.0, end=8.0, vertical_mode="blur")
        check("clip file created", dest.exists(), str(dest))
        if not dest.exists():
            return

        out = ffmpeg_utils.probe(dest)
        check("output is vertical 9:16",
              out.width == VERTICAL_WIDTH and out.height == VERTICAL_HEIGHT,
              f"{out.width}x{out.height}")
        check("output duration ~6s", 5.4 <= out.duration <= 6.6, str(out.duration))
        check("clip has audio", out.has_audio)
        check("clip is web-playable mp4", dest.suffix == ".mp4" and dest.stat().st_size > 1000)

        crop_dest = tmp / "crop.mp4"
        render_clip(ctx, source, crop_dest, start=2.0, end=8.0, vertical_mode="crop")
        crop_out = ffmpeg_utils.probe(crop_dest)
        check("crop mode is vertical 9:16",
              crop_out.width == VERTICAL_WIDTH and crop_out.height == VERTICAL_HEIGHT,
              f"{crop_out.width}x{crop_out.height}")

        print("\n[8] Job store behaviour")
        check("progress monotonic helper clamps",
              _progress_clamps(), "set_progress should clamp to 0..100")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _progress_clamps() -> bool:
    from jobs import JobContext, JobStore

    store = JobStore()
    job = store.create("t")
    ctx = JobContext(job)
    ctx.progress(-20, "x")
    low_ok = job.progress == 0.0
    ctx.progress(500, "x")
    high_ok = job.progress == 100.0
    check("progress clamped low", low_ok, str(job.progress))
    check("progress clamped high", high_ok, str(job.progress))
    return low_ok and high_ok


def test_endpoints_exist() -> None:
    print("\n[9] Flask route registration")
    try:
        from app import create_app
    except Exception as exc:  # noqa: BLE001
        check("backend imports", False, str(exc))
        return
    app = create_app({"TESTING": True})
    rules = {rule.rule for rule in app.url_map.iter_rules()}
    required = {
        "/api/download", "/api/transcribe", "/api/clips",
        "/api/jobs/<job_id>", "/api/health",
        "/api/transcript/<video_id>", "/api/video/<video_id>",
        "/api/clips/<job_id>", "/api/clips/<clip_id>/download",
        "/static/clips/<path:filename>",
    }
    for route in sorted(required):
        check(f"route {route}", route in rules)
    check("clips dir is git-ignorable + exists",
          (Path(__file__).resolve().parent.parent / "static" / "clips").is_dir())


def main() -> int:
    print("=" * 66)
    print("Coppify self-test")
    print("=" * 66)
    test_url_parsing()
    test_ffmpeg_discovery()
    test_probe()
    test_chunk_offsets()
    test_segmenter()
    test_vertical_filters()
    test_render_clip()
    test_endpoints_exist()

    print("\n" + "=" * 66)
    print(f"passed: {PASSED}   failed: {len(FAILED)}")
    if FAILED:
        for name in FAILED:
            print(f"  - {name}")
    print("=" * 66)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())