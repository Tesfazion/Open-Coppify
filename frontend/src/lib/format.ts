/** Shared formatters and small view helpers. */

const HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]

const ID_RE = /^[A-Za-z0-9_-]{11}$/
const PATH_PREFIXES = ['shorts', 'live', 'embed', 'v']

/**
 * Client-side mirror of the backend's extractVideoId so the form can show
 * instant feedback without a round trip. Returns null for anything invalid.
 */
export function extractVideoId(raw: string): string | null {
  const value = (raw || '').trim()
  if (!value) return null
  if (ID_RE.test(value)) return value

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const host = parsed.hostname.toLowerCase()
  if (!HOSTS.includes(host) && !host.endsWith('.youtube.com')) return null

  let candidate = ''
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    candidate = parsed.pathname.replace(/^\//, '').split('/')[0] || ''
  } else if (parsed.pathname === '/watch') {
    candidate = parsed.searchParams.get('v') || ''
  } else {
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length >= 2 && PATH_PREFIXES.includes(segments[0])) {
      candidate = segments[1]
    }
  }

  return ID_RE.test(candidate) ? candidate : null
}

/** 4:07, or 1:04:07 past an hour. */
export function formatDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/** Zero-padded timecode for transcript rows and trim handles: 1:04:07. */
export function formatTimestamp(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

export function formatBytes(bytes: number | null | undefined): string {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** CSS aspect-ratio value for a ratio label like "9:16". */
export function ratioToFraction(ratio: string | undefined): string {
  const [w, h] = String(ratio || '9:16')
    .split(':')
    .map((part) => Number(part) || 1)
  return `${w} / ${h}`
}

export const ASPECT_FALLBACK = '9:16'
