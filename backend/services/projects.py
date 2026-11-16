"""Index of everything on disk, for the UI's history and library screens.

Until now the only way back to a previously downloaded video was to remember its
id and paste it back into the form: the gallery showed every clip ever rendered,
but the operator had no way to see which source a clip came from, what had been
transcribed, or what a given video was even called. ``GET /api/projects`` is that
missing index.

It is derived entirely from the filesystem rather than a database, because that
is already the source of truth -- ``static/downloads/<id>/`` holds the media and
``.info.json`` sidecars hold the metadata. A separate index file would only be a
second thing that can drift out of sync with the files it describes.

Cost control: scanning and parsing sidecars on every request would be wasteful,
so results are cached and invalidated by the mtime of the directories involved.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from config import DOWNLOADS_DIR, TRANSCRIPTS_DIR
from services import clipper, downloader

_CACHE_TTL_SECONDS = 5.0

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "signature": None, "projects": []}

MEDIA_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".mp3", ".m4a", ".wav"}


def _directory_signature() -> tuple[Any, ...]:
    """Cheap fingerprint of the downloads tree, used to invalidate the cache."""
    parts: list[Any] = []
    if not DOWNLOADS_DIR.is_dir():
        return ()
    for entry in sorted(DOWNLOADS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        media_bytes = 0
        media_count = 0
        try:
            for media in entry.iterdir():
                if media.is_file() and media.suffix.lower() in MEDIA_SUFFIXES:
                    media_bytes += media.stat().st_size
                    media_count += 1
        except OSError:
            pass
        parts.append((entry.name, int(stat.st_mtime), media_count, media_bytes))
    return tuple(parts)


def _read_sidecar(media: Path) -> dict[str, Any]:
    sidecar = media.with_suffix(".info.json")
    if not sidecar.exists():
        return {}
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - a bad sidecar must not hide the project
        return {}
    return data if isinstance(data, dict) else {}


def _describe(video_id: str, clips: list[dict[str, Any]]) -> dict[str, Any]:
    """Build one project record from disk. Shared by list and detail lookups."""
    media = downloader.find_existing_video(video_id)
    info = _read_sidecar(media) if media else {}

    transcript_path = downloader.transcript_path(video_id)
    has_transcript = transcript_path.exists()

    clip_count = len(clips)
    kept = sum(1 for clip in clips if clip.get("status") == "kept")
    latest = max((float(clip.get("created_at") or 0) for clip in clips), default=0.0)

    thumbnail = info.get("thumbnail")
    duration = info.get("duration")
    try:
        duration = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration = None

    return {
        "video_id": video_id,
        "title": info.get("title") or f"YouTube video {video_id}",
        "uploader": info.get("uploader"),
        "duration": duration,
        "width": info.get("width"),
        "height": info.get("height"),
        "thumbnail": thumbnail,
        "webpage_url": info.get("webpage_url")
        or downloader.canonical_url(video_id),
        "downloaded": media is not None,
        "has_transcript": has_transcript,
        "transcript_path": str(transcript_path) if has_transcript else None,
        "clip_count": clip_count,
        "kept_count": kept,
        "created_at": latest or (media.stat().st_mtime if media else 0.0),
        "updated_at": latest,
    }


def list_projects(*, include_empty: bool = True) -> list[dict[str, Any]]:
    """Every video Coppify holds media or clips for, newest first."""
    if not DOWNLOADS_DIR.is_dir():
        return []

    signature = _directory_signature()
    now = time.time()

    with _lock:
        fresh = (
            _cache["signature"] == signature
            and now - float(_cache["at"]) < _CACHE_TTL_SECONDS
        )
        if fresh:
            return list(_cache["projects"])

    video_ids = {entry.name for entry in DOWNLOADS_DIR.iterdir() if entry.is_dir()}
    all_clips = clipper.list_clips()
    by_video: dict[str, list[dict[str, Any]]] = {}
    for clip in all_clips:
        by_video.setdefault(str(clip.get("video_id") or ""), []).append(clip)
    # A clip whose source download was cleaned up still deserves a row, otherwise
    # rendered work silently disappears from the library.
    video_ids.update(key for key in by_video if key)

    projects = [
        _describe(video_id, by_video.get(video_id, [])) for video_id in sorted(video_ids)
    ]

    if not include_empty:
        projects = [p for p in projects if p["downloaded"] or p["clip_count"]]

    projects.sort(key=lambda item: float(item.get("updated_at") or 0), reverse=True)

    with _lock:
        _cache.update({"at": now, "signature": signature, "projects": projects})

    return list(projects)


def get_project(video_id: str) -> dict[str, Any] | None:
    """One project by id, or ``None`` when nothing is known about it."""
    if not video_id:
        return None
    for project in list_projects():
        if project["video_id"] == video_id:
            return project
    return None


def library_summary() -> dict[str, Any]:
    """Disk and content totals, for the Settings screen."""
    projects = list_projects()
    clips = clipper.list_clips()

    media_bytes = 0
    for project in projects:
        if not project["downloaded"]:
            continue
        directory = downloader.video_dir(project["video_id"])
        try:
            for path in directory.iterdir():
                if path.is_file() and path.suffix.lower() in MEDIA_SUFFIXES:
                    media_bytes += path.stat().st_size
        except OSError:
            continue

    return {
        "projects": len(projects),
        "clips": len(clips),
        "kept": sum(1 for clip in clips if clip.get("status") == "kept"),
        "transcripts": len(list(TRANSCRIPTS_DIR.glob("*.json"))),
        "media_bytes": media_bytes,
    }


def invalidate() -> None:
    """Drop the cache. Called after any mutation that changes what is on disk."""
    with _lock:
        _cache.update({"at": 0.0, "signature": None, "projects": []})