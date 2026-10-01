"""Choose which 30-60s moments of a video are worth clipping.

Two inputs drive this module:

``segments``  word/segment level timestamps from Whisper
``keywords``  optional user-supplied terms to hunt for

Candidates are built by sliding over segment boundaries (never mid-sentence
boundaries by accident), then ranked on five signals:

1. **Keyword density** - how often the requested terms appear in the window.
2. **Speech density** - words/second versus the video's own median. Dense,
   fast talking sections usually make better short-form content.
3. **Boundary quality** - bonus for starting after a sentence ends and for
   ending on a sentence boundary, so clips don't begin or end mid-word.
4. **Length fit** - closer to ``target_seconds`` scores higher.
5. **Position** - the first/last few seconds of a video are usually intros,
   outros and music, so they are penalised.

Selection is greedy with a minimum-gap constraint, so the gallery never shows
five variations of the same 40 seconds.
"""

from __future__ import annotations

import bisect
import re
from typing import Any

from config import (
    CLIP_EDGE_TRIM,
    CLIP_MAX_SECONDS,
    CLIP_MIN_GAP,
    CLIP_MIN_SECONDS,
    CLIP_TARGET_SECONDS,
)

_WORD_RE = re.compile(r"[\w'’-]+", re.UNICODE)
_SENTENCE_END_RE = re.compile(r"[.!?…][\"')\]]?\s*$")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _normalize_segments(transcript: dict[str, Any]) -> list[dict[str, Any]]:
    segments = [
        segment
        for segment in (transcript.get("segments") or [])
        if isinstance(segment, dict)
        and segment.get("text")
        and segment.get("end", 0) > segment.get("start", 0)
    ]
    segments.sort(key=lambda segment: float(segment["start"]))
    return [
        {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": str(segment["text"]).strip(),
        }
        for segment in segments
    ]


def _count_words(text: str) -> int:
    return len(_WORD_RE.findall(text or ""))


def _keyword_patterns(keywords: list[str]) -> list[tuple[str, re.Pattern[str]]]:
    patterns = []
    for keyword in keywords:
        cleaned = (keyword or "").strip()
        if not cleaned:
            continue
        # Escape the term so user input like "c++" or "a.b" cannot break regex.
        patterns.append((cleaned, re.compile(rf"\b{re.escape(cleaned)}\b", re.IGNORECASE)))
    return patterns


def _snap_to_words(
    start: float, end: float, words: list[dict[str, Any]]
) -> tuple[float, float]:
    """Pull ``start``/``end`` onto the nearest real word boundary."""
    if not words:
        return start, end
    starts = [float(word["start"]) for word in words if word.get("start") is not None]
    ends = [float(word["end"]) for word in words if word.get("end") is not None]
    if not starts or not ends:
        return start, end

    index = bisect.bisect_left(starts, start)
    if index < len(starts) and starts[index] - start <= 1.0:
        start = starts[index]

    index = bisect.bisect_right(ends, end)
    if index > 0 and end - ends[index - 1] <= 1.0:
        end = ends[index - 1]

    if end <= start:
        return start, end
    return start, end


# ---------------------------------------------------------------------------
# Candidate generation
# ---------------------------------------------------------------------------
def build_candidates(
    transcript: dict[str, Any],
    *,
    min_seconds: float = CLIP_MIN_SECONDS,
    max_seconds: float = CLIP_MAX_SECONDS,
    target_seconds: float = CLIP_TARGET_SECONDS,
    edge_trim: float = CLIP_EDGE_TRIM,
    keywords: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Enumerate every legal (start, end) window and score it."""
    segments = _normalize_segments(transcript)
    if not segments:
        return []

    duration = float(transcript.get("duration") or segments[-1]["end"])
    words = [
        word
        for word in (transcript.get("words") or [])
        if word.get("start") is not None and word.get("end") is not None
    ]
    patterns = _keyword_patterns(keywords or [])

    starts = [segment["start"] for segment in segments]
    ends = [segment["end"] for segment in segments]

    # Speech density baseline for this particular video.
    densities: list[float] = []
    for index, segment in enumerate(segments):
        span = segment["end"] - segment["start"]
        if span > 0:
            densities.append(_count_words(segment["text"]) / span)
    median_density = sorted(densities)[len(densities) // 2] if densities else 0.0

    max_start = max(0.0, duration - edge_trim)
    min_end = min(duration, edge_trim)

    candidates: list[dict[str, Any]] = []
    seen: set[tuple[float, float]] = set()

    for start_index, segment in enumerate(segments):
        raw_start = segment["start"]
        if raw_start > max_start or raw_start + min_seconds > max_start:
            continue

        # Longest window that still fits inside max_seconds.
        limit = raw_start + max_seconds
        last_end_index = bisect.bisect_right(ends, limit) - 1
        if last_end_index < start_index:
            continue

        # Prefer the window closest to target_seconds, plus the shortest
        # legal one (some sections are dense enough to hit 30s quickly).
        target_end = raw_start + target_seconds
        target_index = bisect.bisect_right(ends, target_end) - 1
        shortest_index = bisect.bisect_left(ends, raw_start + min_seconds)

        for end_index in {
            max(start_index, min(last_end_index, target_index)),
            max(start_index, min(last_end_index, shortest_index)),
            last_end_index,
        }:
            if end_index < start_index:
                continue
            window_start = raw_start
            window_end = ends[end_index]
            if window_end - window_start > max_seconds + 0.01:
                continue
            if window_end - window_start < min_seconds - 0.75:
                continue
            if window_start < min_end or window_end > max_start:
                continue

            window_start, window_end = _snap_to_words(window_start, window_end, words)
            if window_end - window_start < min_seconds - 0.75:
                continue
            if window_end - window_start > max_seconds + 0.01:
                continue

            key = (round(window_start, 2), round(window_end, 2))
            if key in seen:
                continue
            seen.add(key)

            body = " ".join(
                item["text"] for item in segments[start_index : end_index + 1]
            )
            candidates.append(
                _score_candidate(
                    window_start=window_start,
                    window_end=window_end,
                    body=body,
                    segments=segments,
                    start_index=start_index,
                    end_index=end_index,
                    patterns=patterns,
                    median_density=median_density,
                    target_seconds=target_seconds,
                    duration=duration,
                )
            )

    candidates.sort(key=lambda candidate: candidate["score"], reverse=True)
    return candidates


def _score_candidate(
    *,
    window_start: float,
    window_end: float,
    body: str,
    segments: list[dict[str, Any]],
    start_index: int,
    end_index: int,
    patterns: list[tuple[str, re.Pattern[str]]],
    median_density: float,
    target_seconds: float,
    duration: float,
) -> dict[str, Any]:
    window = window_end - window_start
    words = _count_words(body)
    reasons: list[str] = []

    # 1. Keyword density.
    hits: dict[str, int] = {}
    for keyword, pattern in patterns:
        count = len(pattern.findall(body))
        if count:
            hits[keyword] = count
    keyword_hits = sum(hits.values())
    if hits:
        top = max(hits, key=lambda key: hits[key])
        reasons.append(f"contains \"{top}\" x{hits[top]}")

    # 2. Speech density vs this video's median.
    density = words / window if window > 0 else 0.0
    density_ratio = (density / median_density) if median_density > 0 else 1.0
    if density_ratio > 1.6:
        reasons.append("high speech density")

    # 3. Boundary quality.
    opens_cleanly = start_index == 0 or bool(
        _SENTENCE_END_RE.search(segments[start_index - 1]["text"])
    )
    closes_cleanly = bool(_SENTENCE_END_RE.search(segments[end_index]["text"]))
    if opens_cleanly:
        reasons.append("clean opening")
    if closes_cleanly:
        reasons.append("clean ending")

    # 4. Length fit.
    length_ratio = 1.0 - min(1.0, abs(window - target_seconds) / max(target_seconds, 1.0))

    # 5. Position penalty.
    edge = CLIP_EDGE_TRIM * 3
    position_penalty = 0.0
    if window_start < edge:
        position_penalty += 0.25
    if duration and window_end > duration - edge:
        position_penalty += 0.25

    score = (
        min(1.0, keyword_hits / 4.0) * 2.5
        + min(2.0, max(0.0, density_ratio - 1.0) / 2.0) * 1.0
        + (0.35 if opens_cleanly else 0.0)
        + (0.35 if closes_cleanly else 0.0)
        + length_ratio * 0.8
        - position_penalty
    )

    return {
        "start": round(window_start, 2),
        "end": round(window_end, 2),
        "duration": round(window, 2),
        "score": round(score, 4),
        "text": body.strip(),
        "words": words,
        "keyword_hits": keyword_hits,
        "keywords": sorted(hits, key=lambda key: -hits[key]),
        "reasons": reasons,
    }


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------
def select_clips(
    transcript: dict[str, Any],
    *,
    count: int = 5,
    keywords: list[str] | None = None,
    min_seconds: float = CLIP_MIN_SECONDS,
    max_seconds: float = CLIP_MAX_SECONDS,
    target_seconds: float = CLIP_TARGET_SECONDS,
    min_gap: float = CLIP_MIN_GAP,
) -> list[dict[str, Any]]:
    """Pick up to ``count`` non-overlapping, well-spaced clips."""
    duration = float(transcript.get("duration") or 0.0)
    keywords = [keyword for keyword in (keywords or []) if (keyword or "").strip()]

    candidates = build_candidates(
        transcript,
        min_seconds=min_seconds,
        max_seconds=max_seconds,
        target_seconds=target_seconds,
        keywords=keywords,
    )

    if candidates:
        return _greedy(candidates, count=count, min_gap=min_gap)

    # No usable transcript (silent video, or a transcript we could not build):
    # fall back to evenly spaced windows so the user still gets clips.
    return _evenly_spaced(
        duration=duration or min_seconds,
        count=count,
        target_seconds=target_seconds,
        min_seconds=min_seconds,
        max_seconds=max_seconds,
    )


def _greedy(
    candidates: list[dict[str, Any]], *, count: int, min_gap: float
) -> list[dict[str, Any]]:
    picks: list[dict[str, Any]] = []
    for candidate in candidates:
        if len(picks) >= count:
            break
        clashes = False
        for chosen in picks:
            gap = max(candidate["start"], chosen["start"]) - min(
                candidate["end"], chosen["end"]
            )
            if gap < min_gap:
                clashes = True
                break
        if clashes:
            continue
        pick = dict(candidate)
        pick.setdefault("reasons", []).append("high score")
        picks.append(pick)

    # If the gap constraint starved us, relax it rather than return too few.
    if len(picks) < count:
        for candidate in candidates:
            if len(picks) >= count:
                break
            if any(
                abs(candidate["start"] - chosen["start"]) < 0.5
                and abs(candidate["end"] - chosen["end"]) < 0.5
                for chosen in picks
            ):
                continue
            pick = dict(candidate)
            pick.setdefault("reasons", []).append("high score (relaxed spacing)")
            picks.append(pick)

    picks.sort(key=lambda pick: pick["start"])
    for index, pick in enumerate(picks, start=1):
        pick["index"] = index
    return picks


def _evenly_spaced(
    *,
    duration: float,
    count: int,
    target_seconds: float,
    min_seconds: float,
    max_seconds: float,
) -> list[dict[str, Any]]:
    if duration <= 0:
        return []

    window = min(max(target_seconds, min_seconds), max_seconds, duration)
    if window < 3.0:
        return []

    usable = max(0.0, duration - window)
    picks: list[dict[str, Any]] = []
    for index in range(count):
        if usable <= 0:
            start = 0.0
        else:
            # Centre each window in its slice of the timeline.
            slice_length = usable / count
            start = round(index * slice_length + slice_length / 2 - window / 2, 2)
        start = max(0.0, min(start, duration - window))
        end = round(start + window, 2)
        picks.append(
            {
                "index": index + 1,
                "start": start,
                "end": end,
                "duration": round(window, 2),
                "score": 0.0,
                "text": "",
                "words": 0,
                "keyword_hits": 0,
                "keywords": [],
                "reasons": ["evenly spaced (no transcript available)"],
            }
        )
    return picks