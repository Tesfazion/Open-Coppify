"""Speech-to-text via OpenAI's Whisper (https://github.com/openai/whisper).

Whisper is used as a **local library** -- no API key, no network round-trip per
request beyond the one-time model download. ``word_timestamps=True`` gives us
word-level boundaries, which the clipper uses to snap clip cuts to real speech
onsets instead of arbitrary multiples of 30 seconds.

Chunking
--------
``whisper.transcribe()`` has no progress callback, so a long video would appear
frozen. We therefore slice the audio into overlapping chunks with FFmpeg,
transcribe each one, offset the timestamps and de-duplicate the overlap. The
result is honest incremental progress plus the same word-level precision.

An optional ``faster-whisper`` backend is used automatically when installed,
because it is several times quicker on CPU.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any

from config import (
    CLIP_MAX_SECONDS,
    TMP_DIR,
    TRANSCRIPTS_DIR,
    WHISPER_COMPUTE_TYPE,
    WHISPER_DEVICE,
    WHISPER_FALLBACK_MODELS,
    WHISPER_LANGUAGE,
    WHISPER_MODEL,
)
from jobs import JobContext
from services import ffmpeg_utils

# Audio chunk length for incremental progress. Larger = fewer boundary seams.
CHUNK_SECONDS = 300
# How much each chunk overlaps its predecessor, so words are not cut in half.
CHUNK_OVERLAP = 2.0


class TranscriptionError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
_loaded_backends: dict[str, Any] = {}


def _resolve_device() -> str:
    if WHISPER_DEVICE and WHISPER_DEVICE != "auto":
        return WHISPER_DEVICE
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def _faster_whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def load_model(model_name: str, ctx: JobContext):
    """Load (and cache) a Whisper model, preferring faster-whisper when present."""
    backend = "openai-whisper"
    if _faster_whisper_available():
        backend = "faster-whisper"

    cache_key = f"{backend}:{model_name}"
    if cache_key in _loaded_backends:
        ctx.log(f"Reusing loaded model '{model_name}' ({backend})")
        return _loaded_backends[cache_key], backend

    ctx.progress(4, f"Loading Whisper '{model_name}' ({backend})")
    if backend == "faster-whisper":
        from faster_whisper import WhisperModel

        compute_type = WHISPER_COMPUTE_TYPE
        device = _resolve_device()
        if device == "cuda":
            compute_type = "float16"
        ctx.log(f"faster-whisper device={device} compute_type={compute_type}")
        model = WhisperModel(
            model_name, device=device, compute_type=compute_type
        )
    else:
        import whisper

        device = _resolve_device()
        ctx.log(f"openai-whisper device={device}")
        model = whisper.load_model(model_name, device=device)

    _loaded_backends[cache_key] = model
    return model, backend


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------
def _chunk_bounds(duration: float) -> list[tuple[float, float]]:
    """Split ``duration`` into overlapping ``(start, end)`` windows."""
    if duration <= 0:
        return [(0.0, float(CLIP_MAX_SECONDS))]

    bounds: list[tuple[float, float]] = []
    stride = max(1.0, CHUNK_SECONDS - CHUNK_OVERLAP)
    start = 0.0
    while start < duration:
        end = min(duration, start + CHUNK_SECONDS)
        bounds.append((round(start, 3), round(end, 3)))
        if end >= duration:
            break
        start += stride
    return bounds


def _extract_chunk(src: Path, start: float, end: float, dest: Path) -> Path:
    """Cut ``[start, end)`` out of ``src`` into 16 kHz mono PCM for Whisper."""
    result = ffmpeg_utils.run_ffmpeg(
        [
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{max(0.5, end - start):.3f}",
            "-i",
            str(src),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(dest),
        ],
        timeout=900,
    )
    if result.returncode != 0 or not dest.exists():
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        raise TranscriptionError(f"FFmpeg could not slice audio: {stderr[-400:]}")
    return dest


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------
def transcribe_media(
    ctx: JobContext,
    media_path: str | Path,
    *,
    video_id: str,
    language: str | None = None,
    model_name: str | None = None,
    include_words: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    """Transcribe ``media_path`` and return (and cache) a timestamped transcript."""
    media_path = Path(media_path)
    if not media_path.exists():
        raise FileNotFoundError(f"Media file not found: {media_path}")

    wanted_model = model_name or WHISPER_MODEL

    if not force:
        cached = _load_cached(video_id)
        if cached and cached.get("model") == wanted_model:
            ctx.progress(99, "Using cached transcript")
            ctx.log(f"Cached transcript found for {video_id}")
            return cached

    ctx.progress(2, "Inspecting media")
    try:
        media_info = ffmpeg_utils.probe(media_path)
    except Exception:  # noqa: BLE001 - probing is best effort
        media_info = None

    duration = media_info.duration if media_info else 0.0
    if not duration:
        duration = max(CHUNK_SECONDS, float(CLIP_MAX_SECONDS))

    ctx.check_cancelled()

    # Model loading can take a while on first run (downloads weights).
    model, backend = load_model(wanted_model, ctx)
    ctx.progress(38, "Model ready, preparing audio")
    ctx.check_cancelled()

    lang = language or WHISPER_LANGUAGE
    bounds = _chunk_bounds(duration)
    total_chunks = len(bounds)

    merged_segments: list[dict[str, Any]] = []
    merged_words: list[dict[str, Any]] = []
    full_text_parts: list[str] = []
    detected_language = lang or None
    segment_offset = 0.0
    # Words are de-duplicated against their own cursor. Reusing
    # ``segment_offset`` here would silently discard every word in a chunk,
    # because the segment pass has already advanced past them.
    word_offset = 0.0

    tmp_dir = TMP_DIR / f"whisper_{video_id}"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    try:
        for index, (start, end) in enumerate(bounds, start=1):
            ctx.check_cancelled()
            span = f"{start:.0f}s-{end:.0f}s"
            base = 38 + 60 * ((index - 1) / max(1, total_chunks))
            ctx.progress(base, f"Transcribing chunk {index}/{total_chunks} ({span})")

            chunk_file = tmp_dir / f"chunk_{index:03d}.wav"
            try:
                _extract_chunk(media_path, start, end, chunk_file)
                payload = _transcribe_chunk(
                    model, backend, chunk_file, lang, include_words
                )
            finally:
                chunk_file.unlink(missing_ok=True)

            for segment in payload.get("segments", []):
                absolute_start = float(segment.get("start", 0.0)) + start
                absolute_end = float(segment.get("end", 0.0)) + start
                text = (segment.get("text") or "").strip()
                if not text:
                    continue
                # Whisper occasionally reports a tail that runs past the slice
                # it was given; clamp to both the chunk and the media.
                absolute_end = min(absolute_end, end, duration)
                if absolute_end <= absolute_start:
                    continue
                # Drop segments already covered by the previous chunk's overlap.
                if absolute_start < segment_offset - 0.05:
                    continue
                absolute_start = max(absolute_start, segment_offset)
                if absolute_end <= absolute_start:
                    continue
                merged_segments.append(
                    {
                        "id": len(merged_segments),
                        "start": round(absolute_start, 3),
                        "end": round(absolute_end, 3),
                        "text": text,
                    }
                )
                full_text_parts.append(text)
                segment_offset = max(segment_offset, absolute_end)

            if include_words:
                for word in payload.get("words", []):
                    word_start = float(word.get("start", 0.0)) + start
                    word_end = float(word.get("end", 0.0)) + start
                    token = (word.get("word") or "").strip()
                    if not token:
                        continue
                    word_end = min(word_end, end, duration)
                    if word_end <= word_start:
                        continue
                    if word_start < word_offset - 0.05:
                        continue
                    merged_words.append(
                        {
                            "start": round(word_start, 3),
                            "end": round(word_end, 3),
                            "word": token,
                        }
                    )
                    word_offset = max(word_offset, word_end)

            if payload.get("language"):
                detected_language = payload["language"]
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    ctx.progress(99, "Assembling transcript")

    transcript = {
        "video_id": video_id,
        "model": wanted_model,
        "backend": backend,
        "language": detected_language,
        "duration": round(duration, 2),
        "created_at": time.time(),
        "chunks": total_chunks,
        "text": " ".join(full_text_parts).strip(),
        "segments": merged_segments,
        "words": merged_words,
        "word_count": len(merged_words) or _rough_word_count(" ".join(full_text_parts)),
    }

    path = _save_transcript(video_id, transcript)
    ctx.log(
        f"Transcript ready: {len(merged_segments)} segments, "
        f"{transcript['word_count']} words -> {path.name}"
    )
    return transcript


def _transcribe_chunk(
    model: Any,
    backend: str,
    chunk_file: Path,
    language: str | None,
    include_words: bool,
) -> dict[str, Any]:
    if backend == "faster-whisper":
        segments_iter, info = model.transcribe(
            str(chunk_file),
            language=language,
            word_timestamps=include_words,
            vad_filter=True,
        )
        segments: list[dict[str, Any]] = []
        words: list[dict[str, Any]] = []
        for seg in segments_iter:
            segments.append({"start": seg.start, "end": seg.end, "text": seg.text})
            for word in getattr(seg, "words", None) or []:
                words.append(
                    {"start": word.start, "end": word.end, "word": word.word}
                )
        return {
            "segments": segments,
            "words": words,
            "language": getattr(info, "language", None),
        }

    import whisper

    result = model.transcribe(
        str(chunk_file),
        language=language,
        word_timestamps=include_words,
        fp16=False,
        verbose=None,
    )
    return {
        "segments": [
            {"start": s.get("start", 0.0), "end": s.get("end", 0.0), "text": s.get("text", "")}
            for s in (result.get("segments") or [])
        ],
        "words": result.get("words") or [],
        "language": result.get("language"),
    }


def _rough_word_count(text: str) -> int:
    return len(text.split())


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------
def transcript_file(video_id: str) -> Path:
    import re

    safe = re.sub(r"[^A-Za-z0-9_-]", "", video_id) or "invalid"
    return TRANSCRIPTS_DIR / f"{safe}.json"


def _save_transcript(video_id: str, transcript: dict[str, Any]) -> Path:
    path = transcript_file(video_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(transcript, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return path


def _load_cached(video_id: str) -> dict[str, Any] | None:
    path = transcript_file(video_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def load_transcript(video_id: str) -> dict[str, Any] | None:
    return _load_cached(video_id)


def model_catalog() -> list[dict[str, Any]]:
    """Whisper sizes with rough guidance so the UI can present a dropdown."""
    return [
        {"name": "tiny", "note": "fastest, roughest (~75 MB)"},
        {"name": "base", "note": "default balance (~140 MB)"},
        {"name": "small", "note": "more accurate (~460 MB)"},
        {"name": "medium", "note": "very accurate, slow on CPU (~1.5 GB)"},
        {"name": "large-v3", "note": "best accuracy, needs GPU (~3 GB)"},
    ]


def unload_models() -> None:
    """Free model memory (used by the /api/models/unload helper)."""
    _loaded_backends.clear()


AVAILABLE_FALLBACKS = WHISPER_FALLBACK_MODELS