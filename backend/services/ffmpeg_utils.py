"""Locate, shim and wrap FFmpeg.

Why this module exists
----------------------
FFmpeg is a hard requirement for every stage of this app (muxing downloads,
decoding audio for Whisper, cutting clips), but it is frequently *not* on
``PATH`` -- especially on Windows and in fresh virtualenvs. We therefore:

1. Look for a binary in this order: ``$FFMPEG_BINARY`` -> ``PATH`` ->
   ``imageio-ffmpeg``'s bundled static build -> ``moviepy``'s copy.
2. Build a tiny shim directory containing an executable literally named
   ``ffmpeg.exe`` / ``ffmpeg`` and prepend it to ``os.environ["PATH"]``.

Step 2 is not cosmetic: ``openai-whisper`` calls ``subprocess.run(["ffmpeg",
...])`` by bare name, so the binary has to be discoverable under that exact
name, not under ``imageio_ffmpeg``'s versioned filename.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

from config import BIN_DIR

_IS_WINDOWS = os.name == "nt"
_BINARY_NAME = "ffmpeg.exe" if _IS_WINDOWS else "ffmpeg"

_resolved: str | None = None
_shim_ready = False


class FfmpegNotFound(RuntimeError):
    """Raised when no usable FFmpeg binary could be located."""


class MediaInfo(NamedTuple):
    """Subset of stream metadata we care about for clip rendering."""

    width: int
    height: int
    duration: float
    has_video: bool
    has_audio: bool


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def _bundled_imageio_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _bundled_moviepy_ffmpeg() -> str | None:
    try:
        from moviepy.config import FFMPEG_BINARY

        return str(FFMPEG_BINARY) if FFMPEG_BINARY else None
    except Exception:
        return None


def _find_on_path() -> str | None:
    found = shutil.which("ffmpeg")
    if not found:
        return None
    if _IS_WINDOWS and not found.lower().endswith(".exe"):
        return None
    return found


def _candidates() -> list[str]:
    ordered: list[str] = []
    env_binary = os.environ.get("FFMPEG_BINARY")
    if env_binary:
        ordered.append(env_binary)
    on_path = _find_on_path()
    if on_path:
        ordered.append(on_path)
    for provider in (_bundled_imageio_ffmpeg, _bundled_moviepy_ffmpeg):
        candidate = provider()
        if candidate:
            ordered.append(candidate)
    return ordered


def _works(path: str) -> bool:
    try:
        result = subprocess.run(
            [path, "-version"],
            capture_output=True,
            timeout=30,
            creationflags=_creation_flags(),
        )
    except Exception:
        return False
    return result.returncode == 0 and b"ffmpeg version" in result.stdout


def _creation_flags() -> int:
    # Hide the console window that ffmpeg.exe would otherwise flash on Windows.
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if _IS_WINDOWS else 0


def ffmpeg_path() -> str:
    """Return a verified absolute path to an FFmpeg binary."""
    global _resolved
    if _resolved:
        return _resolved

    for candidate in _candidates():
        if not candidate:
            continue
        resolved = Path(candidate).expanduser()
        if not resolved.exists():
            continue
        if _works(str(resolved)):
            _resolved = str(resolved)
            _ensure_shim(_resolved)
            return _resolved

    raise FfmpegNotFound(
        "FFmpeg was not found. Install it and make sure `ffmpeg` is on PATH, "
        "or run: pip install imageio-ffmpeg"
    )


def _ensure_shim(binary: str) -> None:
    """Expose ``binary`` under the plain name ``ffmpeg`` on ``PATH``.

    A hard link avoids duplicating a ~70 MB file; we fall back to a copy when
    hard links are unavailable (different volume, FAT/exFAT, old Windows).
    """
    global _shim_ready
    if _shim_ready:
        return

    source = Path(binary)
    shim = BIN_DIR / _BINARY_NAME

    try:
        if shim.exists() or shim.is_symlink():
            # Already shimmed in an earlier run, but it may point at a stale
            # location (e.g. different virtualenv). Verify before trusting it.
            if shim.samefile(source):
                _shim_ready = True
            else:
                shim.unlink()

        if not shim.exists():
            try:
                os.link(source, shim)
            except (OSError, NotImplementedError, AttributeError):
                shutil.copy2(source, shim)

        if not _IS_WINDOWS:
            shim.chmod(0o755)
    except Exception:
        # A missing shim is survivable: Whisper will still work if ffmpeg is
        # genuinely on PATH, and every clip render uses the absolute path.
        pass

    bin_dir = str(BIN_DIR)
    current_path = os.environ.get("PATH", "")
    if bin_dir not in current_path.split(os.pathsep):
        os.environ["PATH"] = bin_dir + os.pathsep + current_path
    if os.name != "nt":
        # Some libc/musl builds also consult this for subprocess lookups.
        os.environ.setdefault("LD_LIBRARY_PATH", str(BIN_DIR))

    _shim_ready = True


# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------
def run_ffmpeg(args: list[str], *, timeout: int | None = None) -> subprocess.CompletedProcess:
    """Run ffmpeg with the resolved binary."""
    return subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-nostdin", *args],
        capture_output=True,
        timeout=timeout,
        creationflags=_creation_flags(),
    )


def spawn_ffmpeg(args: list[str], *, stdout_devnull: bool = True) -> subprocess.Popen:
    """Start ffmpeg as a Popen so callers can poll progress and kill it.

    stderr is piped because FFmpeg reports frame progress and the final
    summary there; the caller must drain it. stdout is discarded by default so
    an unread pipe can never fill up and deadlock the child process.
    """
    return subprocess.Popen(
        [ffmpeg_path(), "-hide_banner", "-nostdin", *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL if stdout_devnull else subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_creation_flags(),
    )


def kill_process(process: subprocess.Popen) -> None:
    """Best-effort terminate, escalating to kill if it refuses to exit."""
    try:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    except Exception:
        pass


def escape_filter_path(path: str | Path) -> str:
    """Escape a filesystem path for use inside an FFmpeg filter argument.

    FFmpeg's filtergraph parser treats ``:`` as the option separator, ``\\`` as
    its own escape character, and ``,`` ``;`` ``[`` ``]`` ``=`` as structural
    characters. Windows adds the awkward part: the drive-letter colon must be
    written ``C\\\\:/path``.

    That is *two* backslashes, not one -- the parser strips a single level of
    escaping before the path reaches the filter, so a lone ``C\\:/path`` is
    handed to libass as a malformed path and fails with a bare ``Invalid
    argument``. Verified against ffmpeg 7.1 on Windows.

    Forward slashes are accepted by FFmpeg on all platforms, so we normalise
    first and never have to escape a real backslash.
    """
    text = str(path).replace("\\", "/")
    text = text.replace("'", r"\'")
    text = text.replace(",", r"\,")
    text = text.replace(";", r"\;")
    text = text.replace("[", r"\[")
    text = text.replace("]", r"\]")
    text = text.replace("=", r"\=")
    # Colons are doubled so the parser yields a single literal backslash + colon.
    text = text.replace(":", r"\\:")
    return text


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------
_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
_VIDEO_RE = re.compile(
    r"Stream #\d+:\d+.*?: Video:.*?(\d{2,5})x(\d{2,5})", re.DOTALL
)
_AUDIO_RE = re.compile(r"Stream #\d+:\d+.*?: Audio:")


def probe(path: str | Path) -> MediaInfo:
    """Read width/height/duration/streams by parsing ``ffmpeg -i`` output.

    ``imageio-ffmpeg`` ships no ``ffprobe``, so we deliberately avoid depending
    on it. ``ffmpeg -i <file>`` with no output exits non-zero but still prints
    the full stream table to stderr, which is all we need.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Media file not found: {path}")

    result = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-i", str(path)],
        capture_output=True,
        timeout=120,
        creationflags=_creation_flags(),
    )
    text = (result.stderr or b"").decode("utf-8", errors="replace")
    if result.stderr and not text.strip():
        text = (result.stdout or b"").decode("utf-8", errors="replace")

    duration = 0.0
    duration_match = _DURATION_RE.search(text)
    if duration_match:
        hours, minutes, seconds = duration_match.groups()
        duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)

    width = height = 0
    video_match = _VIDEO_RE.search(text)
    if video_match:
        width, height = int(video_match.group(1)), int(video_match.group(2))

    return MediaInfo(
        width=width,
        height=height,
        duration=duration,
        has_video=bool(video_match),
        has_audio=bool(_AUDIO_RE.search(text)),
    )


def probe_duration(path: str | Path) -> float:
    return probe(path).duration


def ffmpeg_version() -> str:
    """First line of ``ffmpeg -version`` (e.g. ``ffmpeg version 7.1-...``)."""
    result = subprocess.run(
        [ffmpeg_path(), "-version"],
        capture_output=True,
        timeout=30,
        creationflags=_creation_flags(),
    )
    first_line = (result.stdout or b"").decode("utf-8", errors="replace").splitlines()
    return first_line[0] if first_line else "unknown"


@lru_cache(maxsize=1)
def availability() -> dict:
    """Diagnostics surfaced by ``GET /api/health``."""
    report: dict = {
        "ffmpeg": {"ok": False, "path": None, "version": None, "error": None},
        "ffprobe": {"ok": False, "path": shutil.which("ffprobe"), "version": None},
        "shim": {"ok": False, "path": None},
    }
    try:
        path = ffmpeg_path()
        report["ffmpeg"] = {
            "ok": True,
            "path": path,
            "version": ffmpeg_version(),
            "error": None,
        }
    except FfmpegNotFound as exc:
        report["ffmpeg"]["error"] = str(exc)

    shim = BIN_DIR / _BINARY_NAME
    report["shim"] = {"ok": shim.exists(), "path": str(shim) if shim.exists() else None}
    return report