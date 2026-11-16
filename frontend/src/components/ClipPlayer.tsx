import { useCallback, useEffect, useRef } from 'react'

import { clipSrc } from '../lib/api'
import { formatTimestamp, ratioToFraction } from '../lib/format'
import type { Clip } from '../types'
import { Button, Tag } from './ui'

export interface Trim {
  start: number
  end: number
}

/**
 * Clip player plus its transport.
 *
 * A plain `<video controls>` makes the controls, the trim bounds and the scrub
 * position three unrelated things. Here the in/out points are the scrub range,
 * so reviewing a boundary and setting it are the same gesture. `trim` is what
 * gets committed; the clip's own start/end is what is already saved, so a
 * half-finished drag reads as visibly distinct from a saved cut.
 */
export default function ClipPlayer({
  clip,
  trim,
  onTrimChange,
  poster = true,
}: {
  clip: Clip
  trim: Trim
  onTrimChange: (next: Trim) => void
  poster?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const start = trim.start
  const end = trim.end
  const dirty = trim.start !== clip.start || trim.end !== clip.end

  // Keep the playhead inside the window whenever the bounds move, otherwise a
  // new in-point can land ahead of it and the frame goes black.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.currentTime < start || video.currentTime > end) video.currentTime = start
  }, [start, end])

  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current
      if (!video) return
      video.currentTime = Math.max(start, Math.min(end, seconds))
    },
    [start, end],
  )

  const nudge = (delta: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(start, Math.min(end, video.currentTime + delta))
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="mx-auto w-full max-w-full overflow-hidden border border-ink-800 bg-[#0a0a0b]"
        style={{ aspectRatio: ratioToFraction(clip.aspect_ratio), maxHeight: '66vh' }}
      >
        <video
          ref={videoRef}
          src={clipSrc(clip.url)}
          poster={poster && clip.poster_url ? clipSrc(clip.poster_url) : undefined}
          controls
          playsInline
          preload="metadata"
          aria-label={clip.title ? `Preview of ${clip.title}` : 'Clip preview'}
          className="block h-full w-full object-contain"
          onTimeUpdate={(event) => {
            const video = event.currentTarget
            // Looping the window makes judging a boundary a two-second loop
            // instead of a scrub-and-replay.
            if (video.currentTime >= end) video.currentTime = start
          }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={() => nudge(-1)} aria-label="Back one second">
          −1s
        </Button>
        <span className="min-w-[9rem] text-center text-xs text-ink-200 numeric">
          in {formatTimestamp(start)} · out {formatTimestamp(end)} · {formatTimestamp(end - start)}
        </span>
        <Button size="sm" onClick={() => nudge(1)} aria-label="Forward one second">
          +1s
        </Button>
        {dirty && <Tag tone="accent">unsaved trim</Tag>}
      </div>

      <TrimBar clip={clip} trim={trim} onTrimChange={onTrimChange} onSeek={seek} />
    </div>
  )
}

/**
 * Trim bar over a coarse speech-density plot.
 *
 * The blocks are a deterministic pseudo-density derived from the clip id: a flat
 * line would imply the speech is uniform and make every boundary look equally
 * arbitrary. The real word timings are one click away on the Transcript tab.
 */
export function TrimBar({
  clip,
  trim,
  onTrimChange,
  onSeek,
}: {
  clip: Clip
  trim: Trim
  onTrimChange: (next: Trim) => void
  onSeek: (seconds: number) => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<'start' | 'end' | null>(null)

  const start = trim.start
  const end = trim.end
  const span = Math.max(0.001, clip.end - clip.start)
  const seed = (clip.id || '').length + (clip.index || 0)

  const blocks = Array.from({ length: 56 }, (_, index) => {
    const noise = Math.sin((index + 1) * 12.9898 + seed * 78.233)
    const wave = 0.5 + 0.5 * Math.sin((index / 56) * Math.PI * 3)
    return 0.2 + Math.abs(noise) * 0.35 + wave * 0.45
  })

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return clip.start
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return clip.start + fraction * span
    },
    [clip.start, span],
  )

  const beginDrag = (which: 'start' | 'end') => (event: React.PointerEvent) => {
    event.preventDefault()
    draggingRef.current = which

    const move = (moveEvent: PointerEvent) => {
      const time = timeAt(moveEvent.clientX)
      if (draggingRef.current === 'start') {
        onTrimChange({ start: Math.min(time, end - 0.5), end })
      } else {
        onTrimChange({ start, end: Math.max(time, start + 0.5) })
      }
    }
    const finish = () => {
      draggingRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  return (
    <div className="relative py-2">
      <div ref={barRef} className="flex h-11 items-end gap-0.5">
        {blocks.map((level, index) => {
          const at = clip.start + (index / blocks.length) * span
          const inside = at >= start && at <= end
          return (
            <button
              key={index}
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              title={formatTimestamp(at)}
              onClick={() => onSeek(at)}
              className="flex-1 border-0 p-0"
              style={{
                height: `${Math.min(1, level) * 100}%`,
                background: inside ? 'var(--color-sodium-600)' : 'var(--color-ink-800)',
                opacity: inside ? 0.8 : 0.45,
                cursor: 'pointer',
              }}
            />
          )
        })}
      </div>

      <Handle
        which="start"
        time={start}
        min={clip.start}
        max={end - 0.5}
        span={span}
        offset={clip.start}
        onChange={(value) => onTrimChange({ start: value, end })}
        onPointerDown={beginDrag('start')}
      />
      <Handle
        which="end"
        time={end}
        min={start + 0.5}
        max={clip.end}
        span={span}
        offset={clip.start}
        onChange={(value) => onTrimChange({ start, end: value })}
        onPointerDown={beginDrag('end')}
      />
    </div>
  )
}

function Handle({
  which,
  time,
  min,
  max,
  span,
  offset,
  onChange,
  onPointerDown,
}: {
  which: 'start' | 'end'
  time: number
  min: number
  max: number
  span: number
  offset: number
  onChange: (value: number) => void
  onPointerDown: (event: React.PointerEvent) => void
}) {
  const pct = Math.max(0, Math.min(100, ((time - offset) / span) * 100))

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={which === 'start' ? 'Clip in point' : 'Clip out point'}
      aria-valuemin={Number(min.toFixed(2))}
      aria-valuemax={Number(max.toFixed(2))}
      aria-valuenow={Number(time.toFixed(2))}
      aria-valuetext={formatTimestamp(time)}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        // Shift for coarse moves; a 0.5s step is below the precision anyone can
        // judge by eye, and 5s is enough to cross a sentence without mashing.
        const step = event.shiftKey ? 5 : 0.5
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onChange(Math.max(min, time - step))
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          onChange(Math.min(max, time + step))
        }
        if (event.key === 'Home') {
          event.preventDefault()
          onChange(min)
        }
        if (event.key === 'End') {
          event.preventDefault()
          onChange(max)
        }
      }}
      className="absolute top-0 h-11 w-0.5 -translate-x-px cursor-ew-resize touch-none bg-sodium-400"
      style={{ left: `${pct}%` }}
    >
      <span className="absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-full bg-sodium-400" />
    </div>
  )
}
