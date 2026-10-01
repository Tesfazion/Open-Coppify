"""Flask route definitions.

Endpoint surface
----------------
``POST   /api/download``          start a yt-dlp download          -> job
``GET    /api/download/<job_id>`` download job status
``POST   /api/transcribe``        start Whisper transcription     -> job
``GET    /api/transcribe/<job_id>``transcription job status
``POST   /api/clips``             select + render vertical clips  -> job
``GET    /api/clips``             gallery listing of every clip
``GET    /api/clips/<job_id>``    clip job status
``GET    /api/clips/<clip_id>/download``  force-download a clip
``DELETE /api/clips/<clip_id>``   delete a clip
``GET    /api/jobs/<job_id>``     generic status for any job type
``POST   /api/jobs/<job_id>/cancel``    request cancellation
``GET    /api/video/<video_id>``  cached video metadata
``GET    /api/transcript/<video_id>``   cached transcript
``GET    /api/health``            ffmpeg / whisper / yt-dlp status

Every mutating endpoint is asynchronous: it returns a job id immediately and
the frontend polls ``/api/jobs/<job_id>``. The long-running stages (Whisper
model loading, FFmpeg encoding) would otherwise exceed browser and proxy
timeouts.
"""

from __future__ import annotations

import re
from typing import Any

from flask import Blueprint, jsonify, request, send_from_directory

from config import (
    CLIP_MAX_SECONDS,
    CLIP_MIN_SECONDS,
    CLIP_TARGET_SECONDS,
    CLIPS_DIR,
    TRANSCRIPTS_DIR,
    VERTICAL_HEIGHT,
    VERTICAL_WIDTH,
)
from jobs import job_store
from services import clipper, downloader, ffmpeg_utils, transcriber

api = Blueprint("api", __name__, url_prefix="/api")

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


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


@api.get("/clips/<job_id>")
def clips_job_status(job_id: str):
    return _job_response(job_id, "clips")


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


@api.post("/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    if not job_store.cancel(job_id):
        return _error("Job not found or already finished.", 404)
    return jsonify({"ok": True, "cancelling": job_id})


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
    return jsonify({
        "ok": True,
        "defaults": {
            "clip_count": 5,
            "clip_min_seconds": CLIP_MIN_SECONDS,
            "clip_max_seconds": CLIP_MAX_SECONDS,
            "clip_target_seconds": CLIP_TARGET_SECONDS,
            "vertical_modes": ["crop", "blur", "fit"],
            "vertical_mode": "blur",
            "output": {"width": VERTICAL_WIDTH, "height": VERTICAL_HEIGHT},
            "whisper_model": transcriber.WHISPER_MODEL,
            "captions": True,
        },
    })


def register_routes(app) -> None:
    app.register_blueprint(api)