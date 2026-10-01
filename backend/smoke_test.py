"""Live end-to-end smoke test over real HTTP.

Boots the Flask app with ``werkzeug``'s server in a background thread, seeds a
synthetic "video" into the downloads cache, then drives the real endpoints with
``requests`` and asserts on the responses. This exercises routing, the job
store, job polling, transcript caching and the actual FFmpeg encode -- i.e. the
paths a browser would take.

Run with:  python backend/smoke_test.py
"""

from __future__ import annotations

import json
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import requests  # noqa: E402

from app import create_app  # noqa: E402
from config import CLIPS_DIR, DOWNLOADS_DIR, TRANSCRIPTS_DIR  # noqa: E402
from services import downloader, ffmpeg_utils  # noqa: E402

HOST = "127.0.0.1"
PORT = 5099
BASE = f"http://{HOST}:{PORT}"

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


def poll_job(job_id: str, *, timeout: float = 420.0) -> dict:
    """Poll like the frontend does until the job reaches a terminal state."""
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        response = requests.get(f"{BASE}/api/jobs/{job_id}", timeout=30)
        response.raise_for_status()
        last = response.json()["job"]
        if last["status"] in {"succeeded", "failed", "cancelled"}:
            return last
        time.sleep(0.4)
    raise TimeoutError(f"job {job_id} did not finish; last={last}")


def make_seed_video(video_id: str, seconds: int = 140) -> str:
    """Write a synthetic video + metadata sidecar into the download cache."""
    target_dir = downloader.video_dir(video_id)
    path = target_dir / f"{video_id}.mp4"
    result = ffmpeg_utils.run_ffmpeg(
        ["-y",
         "-f", "lavfi", "-i", f"testsrc=size=1280x720:rate=25",
         "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100",
         "-t", str(seconds),
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", str(path)],
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or b"").decode(errors="replace")[-300:])

    downloader.write_info_sidecar(
        video_id,
        {
            "video_id": video_id,
            "title": "Smoke Test: 5 ways to edit video",
            "uploader": "Coppify QA",
            "duration": float(seconds),
            "width": 1280,
            "height": 720,
            "webpage_url": downloader.canonical_url(video_id),
        },
    )
    return str(path)


def main() -> int:
    print("=" * 66)
    print("Coppify live HTTP smoke test")
    print("=" * 66)

    # Keep the polling noise out of the report; we assert on responses instead.
    import logging

    logging.getLogger("werkzeug").setLevel(logging.ERROR)

    video_id = "SMOKETEST01"
    seed_path = make_seed_video(video_id, seconds=140)

    app = create_app()
    server = threading.Thread(
        target=lambda: app.run(host=HOST, port=PORT, threaded=True,
                               use_reloader=False),
        daemon=True,
    )
    server.start()

    # Wait for the socket to accept connections.
    for _ in range(80):
        try:
            requests.get(f"{BASE}/api/health", timeout=2)
            break
        except requests.RequestException:
            time.sleep(0.25)

    try:
        print("\n[1] Health + validation")
        health = requests.get(f"{BASE}/api/health", timeout=30).json()
        check("health.ok", health.get("ok") is True)
        check("ffmpeg detected", health["ffmpeg"]["ok"] is True,
              json.dumps(health.get("ffmpeg", {})))
        check("whisper detected", health["whisper"]["ok"] is True,
              json.dumps(health.get("whisper", {})))
        check("yt-dlp detected", bool(health.get("ytdlp_version")))
        check("9:16 output advertised",
              health["output"]["width"] == 1080 and health["output"]["height"] == 1920)
        check("ffmpeg shim reported", health["ffmpeg_shim"]["ok"] is True)

        bad = requests.post(f"{BASE}/api/download",
                            json={"url": "https://vimeo.com/12345"}, timeout=30)
        check("rejects non-YouTube URL", bad.status_code == 400, str(bad.status_code))
        check("error payload shape", bad.json().get("ok") is False)

        empty = requests.post(f"{BASE}/api/clips", json={}, timeout=30)
        check("rejects missing video id", empty.status_code == 400)

        print("\n[2] Seeded video is visible")
        video = requests.get(f"{BASE}/api/video/{video_id}", timeout=30).json()
        check("video metadata served", video.get("ok") is True)
        check("title round-trips", video["video"]["title"].startswith("Smoke Test"))

        print("\n[3] POST /api/transcribe -> poll /api/jobs/<id>")
        started = requests.post(
            f"{BASE}/api/transcribe",
            json={"video_id": video_id, "model": "tiny"},
            timeout=30,
        )
        check("202 Accepted", started.status_code == 202, str(started.status_code))
        job_id = started.json()["job"]["id"]
        job = poll_job(job_id)
        check("transcribe succeeded", job["status"] == "succeeded",
              f"{job['status']}: {job.get('error')}")
        check("progress reached 100", job["progress"] == 100.0, str(job["progress"]))
        transcript = (job.get("result") or {}).get("transcript") or {}
        check("transcript has segments key", "segments" in transcript)
        check("transcript duration recorded", transcript.get("duration", 0) > 0,
              str(transcript.get("duration")))

        cached = requests.get(f"{BASE}/api/transcript/{video_id}", timeout=30).json()
        check("transcript cached + served", cached.get("ok") is True)

        print("\n[4] POST /api/clips -> real FFmpeg encode")
        started = requests.post(
            f"{BASE}/api/clips",
            json={
                "video_id": video_id,
                "count": 3,
                "min_seconds": 30,
                "max_seconds": 45,
                "target_seconds": 35,
                "vertical_mode": "crop",
                "captions": False,
                "keywords": "video, edit",
            },
            timeout=30,
        )
        check("202 Accepted", started.status_code == 202, str(started.status_code))
        job_id = started.json()["job"]["id"]
        job = poll_job(job_id)
        check("clips job succeeded", job["status"] == "succeeded",
              f"{job['status']}: {job.get('error')}")

        result = job.get("result") or {}
        clips = result.get("clips") or []
        check("3 clips rendered", len(clips) == 3, str(len(clips)))

        for clip in clips:
            check(f"clip {clip['index']} is 9:16",
                  clip["width"] == 1080 and clip["height"] == 1920,
                  f"{clip['width']}x{clip['height']}")
            check(f"clip {clip['index']} within 30-45s",
                  30 <= clip["duration"] <= 45, str(clip["duration"]))
            path = CLIPS_DIR / clip["filename"]
            check(f"clip {clip['index']} exists on disk", path.exists())
            check(f"clip {clip['index']} non-trivial size", path.stat().st_size > 5000,
                  str(path.stat().st_size))

            probed = ffmpeg_utils.probe(path)
            check(f"clip {clip['index']} probed vertical",
                  probed.width == 1080 and probed.height == 1920,
                  f"{probed.width}x{probed.height}")

            served = requests.get(f"{BASE}{clip['url']}", timeout=60)
            check(f"clip {clip['index']} served over /static", served.status_code == 200)
            check(f"clip {clip['index']} content-type is video/mp4",
                  "video/mp4" in served.headers.get("Content-Type", ""),
                  served.headers.get("Content-Type", ""))

            dl = requests.get(f"{BASE}{clip['download_url']}", timeout=60)
            check(f"clip {clip['index']} downloads as attachment",
                  dl.status_code == 200
                  and "attachment" in dl.headers.get("Content-Disposition", ""),
                  dl.headers.get("Content-Disposition", ""))

        print("\n[5] Gallery listing")
        gallery = requests.get(f"{BASE}/api/clips", timeout=30).json()
        check("gallery ok", gallery.get("ok") is True)
        check("gallery lists rendered clips", gallery["count"] >= 3, str(gallery["count"]))
        filtered = requests.get(f"{BASE}/api/clips?video_id={video_id}", timeout=30).json()
        check("gallery filters by video", all(
            c["video_id"] == video_id for c in filtered["clips"]))

        print("\n[6] CORS preflight (needed by the React dev server)")
        preflight = requests.options(
            f"{BASE}/api/clips",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
            timeout=30,
        )
        check("preflight allowed", preflight.status_code in {200, 204},
              str(preflight.status_code))
        check("ACAO header present",
              "Access-Control-Allow-Origin" in preflight.headers)

        print("\n[7] Clip deletion")
        target = clips[0]["id"]
        removed = requests.delete(f"{BASE}/api/clips/{target}", timeout=30).json()
        check("delete ok", removed.get("ok") is True)
        check("file removed", not (CLIPS_DIR / clips[0]["filename"]).exists())
        after = requests.get(f"{BASE}/api/clips", timeout=30).json()
        check("gallery no longer lists it",
              all(c["id"] != target for c in after["clips"]))

    finally:
        print("\n[cleanup]")
        shutil.rmtree(downloader.video_dir(video_id), ignore_errors=True)
        transcript_file = TRANSCRIPTS_DIR / f"{video_id}.json"
        if transcript_file.exists():
            transcript_file.unlink()
        for clip in CLIPS_DIR.glob(f"{video_id}_*"):
            clip.unlink(missing_ok=True)
        remaining = [c for c in CLIPS_DIR.glob("*") if c.name != "manifest.json"]
        for item in remaining:
            item.unlink(missing_ok=True)
        print("  removed seed video, transcript and generated clips")

    print("\n" + "=" * 66)
    print(f"passed: {PASSED}   failed: {len(FAILED)}")
    for name in FAILED:
        print(f"  - {name}")
    print("=" * 66)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())