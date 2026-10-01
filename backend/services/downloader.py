"""Video ingestion via yt-dlp (https://github.com/yt-dlp/yt-dlp).

Responsibilities:
  * validate/normalize the pasted YouTube URL,
  * download a browser-friendly mp4 into ``static/downloads/<video_id>/``,
  * stream byte-level progress into a :class:`~jobs.JobContext`,
  * return the metadata the frontend needs for the gallery header.

Downloads are idempotent: if the target video already exists on disk the
network call is skipped entirely.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from config import (
    DOWNLOADS_DIR,
    KEEP_DOWNLOADED_VIDEOS,
    TMP_DIR,
    TRANSCRIPTS_DIR,
    YTDLP_FORMAT,
    YTDLP_MAX_HEIGHT,
    YTDLP_MERGE_FORMAT,
    YTDLP_RETRIES,
    YTDLP_SOCKET_TIMEOUT,
)
from jobs import JobContext
from services import ffmpeg_utils

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "youtu.be",
    "www.youtu.be",
}

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_PATH_PREFIXES = ("shorts", "live", "embed", "v")


class InvalidUrlError(ValueError):
    """Raised for input that is not a single YouTube video URL."""


# ---------------------------------------------------------------------------
# URL handling
# ---------------------------------------------------------------------------
def is_youtube_url(value: str) -> bool:
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    return host in YOUTUBE_HOSTS or host.endswith(".youtube.com")


def extract_video_id(value: str) -> str:
    """Pull the 11-character YouTube id out of any common URL shape.

    Accepts watch URLs, youtu.be short links, /shorts/, /live/, /embed/ and a
    bare id. Raises :class:`InvalidUrlError` for anything else.
    """
    raw = (value or "").strip()
    if not raw:
        raise InvalidUrlError("No URL provided")

    if _VIDEO_ID_RE.match(raw):
        return raw

    if "youtube.com" not in raw.lower() and "youtu.be" not in raw.lower():
        raise InvalidUrlError("Only YouTube links are supported.")

    try:
        parsed = urlparse(raw)
    except ValueError as exc:
        raise InvalidUrlError(f"Could not parse URL: {exc}") from exc

    if parsed.scheme not in {"http", "https"}:
        raise InvalidUrlError("Only http(s) YouTube links are supported.")

    host = (parsed.hostname or "").lower()
    if host not in YOUTUBE_HOSTS and not host.endswith(".youtube.com"):
        raise InvalidUrlError(f"Unsupported host: {host}")

    candidate = ""
    if host in {"youtu.be", "www.youtu.be"}:
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif parsed.path.startswith("/watch"):
        candidate = (parse_qs(parsed.query).get("v") or [""])[0]
    else:
        segments = [segment for segment in parsed.path.split("/") if segment]
        if len(segments) >= 2 and segments[0] in _PATH_PREFIXES:
            candidate = segments[1]

    if not _VIDEO_ID_RE.match(candidate):
        raise InvalidUrlError(
            "Could not find a YouTube video id in that link. "
            "Use a watch, youtu.be, shorts, live or embed URL."
        )
    return candidate


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


# ---------------------------------------------------------------------------
# Filesystem layout
# ---------------------------------------------------------------------------
def video_dir(video_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]", "", video_id) or "invalid"
    path = DOWNLOADS_DIR / safe
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_existing_video(video_id: str) -> Path | None:
    """Return an already-downloaded media file for ``video_id``, if any."""
    directory = video_dir(video_id)
    if not directory.is_dir():
        return None
    preferred = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"}
    candidates = [
        path
        for path in sorted(directory.iterdir())
        if path.is_file() and path.suffix.lower() in preferred
    ]
    if not candidates:
        return None
    # mp4 first (browser friendly), then largest file.
    candidates.sort(key=lambda p: (p.suffix.lower() != ".mp4", -p.stat().st_size))
    return candidates[0]


def _existing_transcript(video_id: str) -> Path | None:
    path = transcript_path(video_id)
    return path if path.exists() else None


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------
def download_video(
    ctx: JobContext,
    url: str,
    *,
    max_height: int | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Download ``url`` (or reuse a local copy) and return its metadata."""
    try:
        import yt_dlp
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise RuntimeError(
            "yt-dlp is not installed. Run: pip install -r backend/requirements.txt"
        ) from exc

    video_id = extract_video_id(url)
    ctx.progress(3, f"Resolved video {video_id}")
    ctx.log(f"Video id: {video_id}")

    target_dir = video_dir(video_id)
    outtmpl = str(target_dir / "%(id)s.%(ext)s")

    height = max_height if max_height and max_height > 0 else YTDLP_MAX_HEIGHT
    format_selector = YTDLP_FORMAT
    if height:
        format_selector = (
            f"best[height<={height}][ext=mp4][vcodec^=avc1][acodec!=none]/"
            f"best[height<={height}][ext=mp4][acodec!=none]/"
            f"bestvideo[height<={height}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][height<={height}]/"
            f"bestvideo[height<={height}][ext=mp4]+bestaudio[height<={height}]/"
            f"best[height<={height}][ext=mp4]/"
            f"{YTDLP_FORMAT}"
        )

    existing = None if force else find_existing_video(video_id)
    if existing is not None:
        ctx.progress(95, "Already downloaded, reusing local file")
        ctx.log(f"Reusing existing file: {existing}")
        info = _probe_existing(video_id, existing)
        info["reused"] = True
        write_info_sidecar(video_id, info)
        return info

    ffmpeg_location = None
    try:
        ffmpeg_location = ffmpeg_utils.ffmpeg_path()
    except ffmpeg_utils.FfmpegNotFound:
        ctx.log("FFmpeg unavailable: audio/video streams may not be merged", "warn")

    if ffmpeg_location:
        path_env = os.environ.get("PATH", "")
        ffmpeg_dir = os.path.dirname(ffmpeg_location)
        if ffmpeg_dir not in path_env.split(os.pathsep):
            os.environ["PATH"] = ffmpeg_dir + os.pathsep + path_env

    # Progress budget: 5% setup, 5-85% download, 85-97% merge/postprocess.
    progress_hooks = [_make_progress_hook(ctx)]

    postprocessor_hooks = [_make_postprocessor_hook(ctx)]

    options: dict[str, Any] = {
        "format": format_selector,
        "outtmpl": outtmpl,
        "merge_output_format": YTDLP_MERGE_FORMAT,
        "noplaylist": True,
        "retries": YTDLP_RETRIES,
        "fragment_retries": YTDLP_RETRIES,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "windowsfilenames": True,
        "overwrites": force,
        "continuedl": True,
        "cachedir": str(TMP_DIR),
        "progress_hooks": progress_hooks,
        "postprocessor_hooks": postprocessor_hooks,
        "logger": _QuietLogger(ctx),
    }
    if ffmpeg_location:
        options["ffmpeg_location"] = ffmpeg_location

    ctx.progress(6, "Fetching video metadata")
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(canonical_url(video_id), download=True)
    except yt_dlp.utils.DownloadError as exc:
        message = str(exc)
        lowered = message.lower()
        if "video unavailable" in lowered or "private video" in lowered:
            raise RuntimeError(
                "YouTube says this video is unavailable or private."
            ) from exc
        if "sign in" in lowered or "confirm you" in lowered or "bot" in lowered:
            raise RuntimeError(
                "YouTube is asking for a sign-in/bot check. Try a different video, "
                "or pass cookies via yt-dlp's cookie options."
            ) from exc
        raise RuntimeError(f"yt-dlp failed: {message}") from exc

    ctx.check_cancelled()
    ctx.progress(92, "Finalising media file")

    downloaded = find_existing_video(video_id)
    if downloaded is None:
        # yt-dlp can finish with a postprocessed file that our glob missed.
        files = sorted(target_dir.glob("*"))
        files = [p for p in files if p.is_file() and p.suffix.lower() != ".part"]
        downloaded = files[0] if files else None
    if downloaded is None:
        raise RuntimeError("yt-dlp reported success but no media file was found.")

    metadata = _build_metadata(info or {}, video_id, downloaded)
    write_info_sidecar(video_id, metadata)
    ctx.progress(97, "Download complete")
    ctx.log(f"Saved {downloaded.name} ({downloaded.stat().st_size / 1e6:.1f} MB)")
    return metadata


def _make_progress_hook(ctx: JobContext):
    def hook(status: dict[str, Any]) -> None:
        ctx.check_cancelled()
        state = status.get("status")
        if state == "downloading":
            total = status.get("total_bytes") or status.get("total_bytes_estimate")
            downloaded = status.get("downloaded_bytes") or 0
            if total:
                fraction = min(1.0, downloaded / total)
                speed = status.get("speed") or 0
                eta = status.get("eta")
                speed_mb = f"{speed / 1e6:.1f} MB/s" if speed else "?"
                eta_text = f"{int(eta)}s" if isinstance(eta, (int, float)) else "?"
                ctx.progress(
                    5 + fraction * 80,
                    f"Downloading {fraction * 100:.0f}% ({speed_mb}, ETA {eta_text})",
                )

    return hook


def _make_postprocessor_hook(ctx: JobContext):
    def hook(status: dict[str, Any]) -> None:
        name = status.get("postprocessor") or "Post-processing"
        if status.get("status") == "started":
            ctx.progress(88, f"Post-processing: {name}")

    return hook


class _QuietLogger:
    """Route yt-dlp's chatter into the job log instead of stdout."""

    def __init__(self, ctx: JobContext):
        self._ctx = ctx

    def debug(self, msg: str) -> None:
        if msg.startswith("[debug] "):
            return
        self._ctx.log(msg, "debug")

    def info(self, msg: str) -> None:
        self._ctx.log(msg)

    def warning(self, msg: str) -> None:
        self._ctx.log(msg, "warn")

    def error(self, msg: str) -> None:
        self._ctx.log(msg, "error")


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------
def _build_metadata(info: dict[str, Any], video_id: str, path: Path) -> dict[str, Any]:
    duration = float(info.get("duration") or 0.0)
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)

    if not duration or not (width and height):
        try:
            probed = ffmpeg_utils.probe(path)
            duration = duration or probed.duration
            width = width or probed.width
            height = height or probed.height
        except Exception:  # noqa: BLE001 - metadata is best-effort
            pass

    return {
        "video_id": video_id,
        "title": info.get("title") or f"YouTube video {video_id}",
        "uploader": info.get("uploader") or info.get("channel") or None,
        "uploader_url": info.get("uploader_url") or None,
        "duration": round(duration, 2),
        "width": width,
        "height": height,
        "thumbnail": info.get("thumbnail"),
        "webpage_url": info.get("webpage_url") or canonical_url(video_id),
        "file_path": str(path),
        "file_name": path.name,
        "file_size": path.stat().st_size if path.exists() else 0,
        "downloaded_at": time.time(),
        "reused": False,
    }


def _probe_existing(video_id: str, path: Path) -> dict[str, Any]:
    """Rebuild metadata for a cached download (title comes from a sidecar)."""
    sidecar = path.with_suffix(".info.json")
    info: dict[str, Any] = {}
    if sidecar.exists():
        try:
            info = json.loads(sidecar.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            info = {}
    return _build_metadata(info, video_id, path)


def write_info_sidecar(video_id: str, metadata: dict[str, Any]) -> None:
    """Persist selected metadata next to the media file for reuse."""
    existing = find_existing_video(video_id)
    if existing is None:
        return
    sidecar = existing.with_suffix(".info.json")
    try:
        existing_info: dict[str, Any] = {}
        if sidecar.exists():
            existing_info = json.loads(sidecar.read_text(encoding="utf-8"))
        existing_info.update(metadata)
        sidecar.write_text(
            json.dumps(existing_info, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        pass


def delete_video_files(video_id: str) -> None:
    """Remove downloaded media (and transcript) for ``video_id``."""
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", video_id or ""):
        return
    shutil.rmtree(video_dir(video_id), ignore_errors=True)
    transcript = transcript_path(video_id)
    if transcript.exists():
        transcript.unlink()


def cleanup_download(ctx: JobContext, video_id: str) -> None:
    if not KEEP_DOWNLOADED_VIDEOS:
        delete_video_files(video_id)
        ctx.log(f"Removed downloaded files for {video_id}")


def transcript_path(video_id: str) -> Path:
    return TRANSCRIPTS_DIR / f"{re.sub(r'[^A-Za-z0-9_-]', '', video_id)}.json"


def cached_transcript(video_id: str) -> dict[str, Any] | None:
    path = transcript_path(video_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None