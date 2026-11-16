import { API_BASE } from '../lib/env'
import { Tag } from './ui'
import type { Health } from '../types'

/**
 * Compact machine status.
 *
 * Surfaced permanently rather than hidden in Settings because the three things
 * it reports — whether FFmpeg can render, whether Whisper can run, and where the
 * API is — are the ones that change how long everything else takes.
 */
export default function SystemBadge({ health, error }: { health: Health | null; error: boolean }) {
  if (error) {
    return (
      <div className="flex items-center gap-3" role="status">
        <Tag tone="bad">backend unreachable</Tag>
        <span className="hidden text-xs text-ink-300 sm:inline">{API_BASE || window.location.origin}</span>
      </div>
    )
  }

  if (!health) {
    return <Tag tone="muted" className="pulsing">checking backend</Tag>
  }

  const ffmpeg = Boolean(health.ffmpeg?.ok)
  const whisper = Boolean(health.whisper?.ok)
  const ytdlp = Boolean(health.ytdlp_version)
  const ready = ffmpeg && whisper && ytdlp

  return (
    <div className="flex items-center gap-4">
      <Tag tone="muted" className="numeric" title="Clips currently on disk">
        {health.clips_on_disk ?? 0} clips
      </Tag>
      <Tag
        tone={ready ? 'good' : 'bad'}
        title={ready ? 'All required components present' : 'See Settings for details'}
      >
        {ready ? 'ready' : 'not ready'}
      </Tag>
    </div>
  )
}
