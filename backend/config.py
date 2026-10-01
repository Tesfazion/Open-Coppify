"""Central configuration for the Coppify backend.

Every tunable lives here so the rest of the code stays free of magic numbers.
Paths are anchored to the *project root* (the parent of ``backend/``) so that
``python backend/app.py`` and ``python app.py`` (from inside ``backend/``)
both resolve to the same ``static/`` tree.
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

STORAGE_DIR = PROJECT_ROOT / "static"
CLIPS_DIR = STORAGE_DIR / "clips"
DOWNLOADS_DIR = STORAGE_DIR / "downloads"
TRANSCRIPTS_DIR = STORAGE_DIR / "transcripts"

# yt-dlp writes temp/partial files here.
TMP_DIR = STORAGE_DIR / "tmp"
# Shims for binaries that are not installed system-wide (see services/ffmpeg_utils).
BIN_DIR = PROJECT_ROOT / ".bin"

for _directory in (STORAGE_DIR, CLIPS_DIR, DOWNLOADS_DIR, TRANSCRIPTS_DIR, TMP_DIR, BIN_DIR):
    _directory.mkdir(parents=True, exist_ok=True)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------
def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


HOST = os.environ.get("COPPIFY_HOST", "127.0.0.1")
PORT = _env_int("COPPIFY_PORT", 5000)
DEBUG = _env_bool("COPPIFY_DEBUG", False)

# Comma separated list, or "*" for any origin (local dev default).
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("COPPIFY_CORS_ORIGINS", "*").split(",")
    if origin.strip()
]

# ---------------------------------------------------------------------------
# Job store
# ---------------------------------------------------------------------------
MAX_TRACKED_JOBS = _env_int("COPPIFY_MAX_JOBS", 200)
# Keep finished jobs in memory this long so the UI can still read final state.
JOB_RETENTION_SECONDS = _env_int("COPPIFY_JOB_RETENTION", 60 * 60 * 6)

# ---------------------------------------------------------------------------
# yt-dlp
# --------------------------------------------------------------------------
YTDLP_FORMAT = os.environ.get(
    "COPPIFY_YTDLP_FORMAT",
    # Prefer H.264/AAC in an mp4 container so clips play in every browser,
    # but fall back through webm/split streams if that is all YouTube offers.
    "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/"
    "bestvideo[ext=mp4]+bestaudio/"
    "best[ext=mp4]/"
    "bestvideo+bestaudio/best",
)
YTDLP_MERGE_FORMAT = "mp4"
YTDLP_MAX_HEIGHT = _env_int("COPPIFY_MAX_HEIGHT", 1080)
YTDLP_RETRIES = _env_int("COPPIFY_YTDLP_RETRIES", 3)
YTDLP_SOCKET_TIMEOUT = _env_int("COPPIFY_YTDLP_TIMEOUT", 30)
DOWNLOAD_TIMEOUT_SECONDS = _env_int("COPPIFY_DOWNLOAD_TIMEOUT", 60 * 60 * 3)

# ---------------------------------------------------------------------------
# Whisper
# ---------------------------------------------------------------------------
# tiny | base | small | medium | large-v3  (see README for speed/accuracy notes)
WHISPER_MODEL = os.environ.get("COPPIFY_WHISPER_MODEL", "base")
WHISPER_LANGUAGE = os.environ.get("COPPIFY_WHISPER_LANGUAGE", "") or None
WHISPER_DEVICE = os.environ.get("COPPIFY_WHISPER_DEVICE", "auto")
WHISPER_FALLBACK_MODELS = [
    model.strip()
    for model in os.environ.get("COPPIFY_WHISPER_FALLBACK_MODELS", "tiny").split(",")
    if model.strip()
]
WHISPER_COMPUTE_TYPE = os.environ.get("COPPIFY_WHISPER_COMPUTE_TYPE", "int8")

# ---------------------------------------------------------------------------
# Clips
# ---------------------------------------------------------------------------
CLIP_MIN_SECONDS = float(os.environ.get("COPPIFY_CLIP_MIN_SECONDS", 30))
CLIP_MAX_SECONDS = float(os.environ.get("COPPIFY_CLIP_MAX_SECONDS", 60))
CLIP_TARGET_SECONDS = float(os.environ.get("COPPIFY_CLIP_TARGET_SECONDS", 45))
CLIP_COUNT = _env_int("COPPIFY_CLIP_COUNT", 5)
# Minimum gap between two clips taken from the same video, in seconds.
CLIP_MIN_GAP = float(os.environ.get("COPPIFY_CLIP_MIN_GAP", 15))
# Ignore the very start/end of a video (intros, outros, outros' music).
CLIP_EDGE_TRIM = float(os.environ.get("COPPIFY_CLIP_EDGE_TRIM", 8))

VERTICAL_WIDTH = _env_int("COPPIFY_VERTICAL_WIDTH", 1080)
VERTICAL_HEIGHT = _env_int("COPPIFY_VERTICAL_HEIGHT", 1920)
CLIP_CRF = _env_int("COPPIFY_CLIP_CRF", 23)
CLIP_PRESET = os.environ.get("COPPIFY_CLIP_PRESET", "veryfast")
CLIP_AUDIO_BITRATE = os.environ.get("COPPIFY_CLIP_AUDIO_BITRATE", "128k")

# Horizontal fallback resolution when the source is taller than 9:16.
CLIP_MAX_WIDTH = _env_int("COPPIFY_CLIP_MAX_WIDTH", 1920)

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------
KEEP_DOWNLOADED_VIDEOS = _env_bool("COPPIFY_KEEP_DOWNLOADS", True)
MAX_UPLOAD_BYTES = _env_int("COPPIFY_MAX_UPLOAD_MB", 2048) * 1024 * 1024