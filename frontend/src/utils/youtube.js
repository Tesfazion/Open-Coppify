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
 * Client-side mirror of the backend's extract_video_id so the form can show
 * instant feedback without a round trip. Returns null for anything invalid.
 */
export function extractVideoId(raw) {
  const value = (raw || '').trim()
  if (!value) return null
  if (ID_RE.test(value)) return value

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const host = parsed.hostname.toLowerCase()
  const allowed = HOSTS.includes(host) || host.endsWith('.youtube.com')
  if (!allowed) return null

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

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function formatBytes(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`
}