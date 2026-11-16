"""Persisted user settings.

The UI used to hard-code its defaults and read them from ``GET /api/config``,
which meant every reload threw away the operator's choices and there was nowhere
to change a default without editing source. This module keeps a small JSON
document in ``static/settings.json`` instead, validated on both read and write so
a hand-edited or truncated file can never put the pipeline into an impossible
state (negative durations, a 4000-clip batch, an unknown aspect ratio).

Writes are atomic: the document is written to a sibling temp file and then
``os.replace``-d, so a crash mid-write leaves the previous settings intact rather
than a half-written file that fails to parse on next boot.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from config import (
    ASPECT_RATIOS,
    CAPTION_STYLES,
    CLIP_COUNT,
    CLIP_MAX_SECONDS,
    CLIP_MIN_SECONDS,
    CLIP_TARGET_SECONDS,
    DEFAULT_ASPECT_RATIO,
    DEFAULT_CAPTION_STYLE,
    STORAGE_DIR,
    VERTICAL_MODE_DEFAULT,
    VERTICAL_MODES,
    WHISPER_MODEL,
)
from services.transcriber import model_catalog

SETTINGS_PATH = STORAGE_DIR / "settings.json"

_lock = threading.RLock()

# Single source of truth for the choices the settings form offers; the tables
# themselves live in config.py next to the ffmpeg settings they describe.
ASPECT_CHOICES = tuple(ASPECT_RATIOS)
VERTICAL_MODE_CHOICES = tuple(VERTICAL_MODES)
CAPTION_STYLE_CHOICES = tuple(CAPTION_STYLES)
WHISPER_MODELS = tuple(entry["name"] for entry in model_catalog())

# Guardrails. These bound what the UI can request so a typo in a PUT body cannot
# queue a three-hour render or a 5000-clip batch.
LIMITS = {
    "clip_count": (1, 30),
    "min_seconds": (5.0, 600.0),
    "max_seconds": (5.0, 1800.0),
    "target_seconds": (5.0, 1800.0),
    "keywords": 30,
}


def _defaults() -> dict[str, Any]:
    return {
        "clip_count": CLIP_COUNT,
        "min_seconds": CLIP_MIN_SECONDS,
        "max_seconds": CLIP_MAX_SECONDS,
        "target_seconds": CLIP_TARGET_SECONDS,
        "vertical_mode": VERTICAL_MODE_DEFAULT,
        "captions": True,
        "auto_transcribe": True,
        "whisper_model": WHISPER_MODEL,
        "aspect_ratio": DEFAULT_ASPECT_RATIO,
        "caption_style": DEFAULT_CAPTION_STYLE,
        "keywords": "",
    }


def _clamp_number(value: Any, name: str, fallback: float) -> float:
    low, high = LIMITS[name]
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(low, min(high, number))


def _clamp_int(value: Any, name: str, fallback: int) -> int:
    low, high = LIMITS[name]
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def _clamp_choice(value: Any, choices: tuple[str, ...], fallback: str) -> str:
    text = str(value or "").strip().lower()
    return text if text in choices else fallback


def sanitize(raw: dict[str, Any] | None, base: dict[str, Any] | None = None) -> dict[str, Any]:
    """Coerce arbitrary input into a valid settings document.

    Unknown keys are dropped and out-of-range values are clamped rather than
    rejected, so a stale client sending an old payload still gets its known
    preferences applied instead of a 400. When ``base`` is given the result is
    layered on top of it, which is how ``PUT /api/settings`` does a partial
    update without resetting keys the client did not mention.
    """
    defaults = _defaults()
    target = dict(base) if isinstance(base, dict) else dict(defaults)
    if not isinstance(raw, dict):
        return sanitize_into(target, defaults)

    data = raw

    if "clip_count" in data:
        target["clip_count"] = _clamp_int(data["clip_count"], "clip_count",
                                          defaults["clip_count"])
    for key in ("min_seconds", "max_seconds", "target_seconds"):
        if key in data:
            target[key] = _clamp_number(data[key], key, defaults[key])

    # min <= target <= max, resolved after the individual clamps so an inverted
    # request (min 300, max 30) still yields a usable ordering.
    target["min_seconds"] = min(target["min_seconds"], target["max_seconds"])
    target["max_seconds"] = max(target["min_seconds"], target["max_seconds"])
    target["target_seconds"] = min(
        max(target["target_seconds"], target["min_seconds"]), target["max_seconds"]
    )

    target["vertical_mode"] = _clamp_choice(
        data.get("vertical_mode", target["vertical_mode"]),
        VERTICAL_MODE_CHOICES,
        defaults["vertical_mode"],
    )
    target["aspect_ratio"] = _clamp_choice(
        data.get("aspect_ratio", target["aspect_ratio"]),
        ASPECT_CHOICES,
        defaults["aspect_ratio"],
    )
    target["whisper_model"] = _clamp_choice(
        data.get("whisper_model", target["whisper_model"]),
        WHISPER_MODELS,
        defaults["whisper_model"],
    )
    target["caption_style"] = _clamp_choice(
        data.get("caption_style", target["caption_style"]),
        CAPTION_STYLE_CHOICES,
        defaults["caption_style"],
    )

    for flag in ("captions", "auto_transcribe"):
        if flag in data:
            value = data[flag]
            if isinstance(value, bool):
                target[flag] = value
            else:
                target[flag] = str(value).strip().lower() in {"1", "true", "yes", "on"}

    if "keywords" in data:
        raw_keywords = data["keywords"]
        if isinstance(raw_keywords, str):
            parts = raw_keywords.split(",")
        elif isinstance(raw_keywords, (list, tuple)):
            parts = [str(item) for item in raw_keywords]
        else:
            parts = []
        cleaned = [part.strip() for part in parts if part.strip()][: LIMITS["keywords"]]
        target["keywords"] = ", ".join(cleaned)

    return target


def sanitize_into(target: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """Apply ``data`` onto an existing dict in place, validating as we go."""
    return sanitize(data, base=target)


def load() -> dict[str, Any]:
    """Return the current settings, falling back to defaults if unreadable."""
    with _lock:
        if not SETTINGS_PATH.exists():
            return _defaults()
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a corrupt file must not break boot
            return _defaults()
        return sanitize(raw)


def save(data: dict[str, Any]) -> dict[str, Any]:
    """Merge ``data`` into the stored settings and return the result."""
    with _lock:
        current = _read_raw()
        merged = sanitize(data if isinstance(data, dict) else {}, base=current)
        _write(merged)
        return merged


def _read_raw() -> dict[str, Any]:
    if not SETTINGS_PATH.exists():
        return _defaults()
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return _defaults()
    return sanitize(raw) if isinstance(raw, dict) else _defaults()


def _write(data: dict[str, Any]) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = SETTINGS_PATH.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, SETTINGS_PATH)


def reset() -> dict[str, Any]:
    """Restore defaults. Used by the Settings screen."""
    with _lock:
        defaults = _defaults()
        _write(defaults)
        return defaults


def public() -> dict[str, Any]:
    """Settings plus the metadata the UI needs to render the form."""
    data = load()
    return {
        "settings": data,
        "aspect_ratios": list(ASPECT_CHOICES),
        "vertical_modes": list(VERTICAL_MODE_CHOICES),
        "whisper_models": [
            {"name": entry["name"], "note": entry["note"]} for entry in model_catalog()
        ],
        "caption_styles": [
            {"key": key, "label": style["label"], "description": style["description"]}
            for key, style in CAPTION_STYLES.items()
        ],
        "limits": {
            key: (list(value) if isinstance(value, tuple) else value)
            for key, value in LIMITS.items()
        },
        "path": str(SETTINGS_PATH),
    }