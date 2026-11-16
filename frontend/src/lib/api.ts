/**
 * Typed client for the Coppify Flask API.
 *
 * Uses the platform `fetch` rather than a bundled HTTP library: one less
 * dependency, no CORS surprises, and every call funnels through `request()` so
 * failures are always the same shape (`ApiError`) the UI already knows how to
 * render.
 */

import { API_BASE } from './env'
import type {
  Clip,
  Health,
  Job,
  JobLogEntry,
  Project,
  ProjectDetail,
  Settings,
  SettingsResponse,
  WordTiming,
} from '../types'

/**
 * A failure the UI can act on.
 *
 * `hint` is the part that matters: "YouTube blocked this download" is a dead
 * end, whereas "set a browser to pull cookies from" is something the operator
 * can do. The backend sends `hint` on the errors where it has a next step.
 */
export class ApiError extends Error {
  hint: string
  status: number
  detail: string

  constructor(message: string, options: { hint?: string; status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'ApiError'
    this.hint = options.hint ?? ''
    this.status = options.status ?? 0
    this.detail = options.detail ?? ''
  }
}

const NETWORK_HINT =
  'Start the backend with "npm run backend", or point VITE_API_URL at the host it is running on.'

interface ApiFieldError {
  error?: string
  hint?: string
  detail?: string
}

/** Turn any thrown value into an ApiError with a readable message and hint. */
export function describeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError('Request cancelled.')
  }
  if (error instanceof Error) {
    return new ApiError(error.message || 'Something went wrong.')
  }
  return new ApiError('Something went wrong.')
}

interface RequestOptions {
  method?: string
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  timeoutMs?: number
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, form, signal, timeoutMs = 30000 } = options

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: form ? undefined : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
      credentials: 'same-origin',
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError('The backend took too long to respond.', {
        hint: 'Long renders run as jobs and are followed on the progress screen.',
      })
    }
    throw new ApiError(`Cannot reach the backend at ${API_BASE || window.location.origin}.`, {
      hint: NETWORK_HINT,
    })
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const field = (data ?? {}) as ApiFieldError
    throw new ApiError(field.error || `Request failed (${response.status}).`, {
      hint: field.hint || '',
      detail: field.detail || '',
      status: response.status,
    })
  }

  return (data ?? {}) as T
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Absolute URL for a backend path, so <video src> works cross-origin. */
export function clipSrc(path: string | null | undefined): string {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  if (!API_BASE) return path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
}

// ---------------------------------------------------------------------------
// Health / config / settings
// ---------------------------------------------------------------------------
export const getHealth = () => request<Health>('/api/health')
export const getSettings = () => request<SettingsResponse>('/api/settings')
export const putSettings = (patch: Partial<Settings>) =>
  request<{ settings: Settings }>('/api/settings', { method: 'PUT', body: patch })
export const resetSettings = () =>
  request<{ settings: Settings }>('/api/settings/reset', { method: 'POST' })

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export interface StartClipsPayload {
  url?: string
  video_id?: string
  count?: number
  min_seconds?: number
  max_seconds?: number
  target_seconds?: number
  keywords?: string
  vertical_mode?: string
  captions?: boolean
  auto_transcribe?: boolean
  model?: string
  aspect_ratio?: string
  caption_style?: string
}

export const startDownload = (payload: Record<string, unknown>) =>
  request<{ job: Job; video_id: string }>('/api/download', { method: 'POST', body: payload })

export const startTranscribe = (payload: Record<string, unknown>) =>
  request<{ job: Job; video_id: string }>('/api/transcribe', { method: 'POST', body: payload })

export const startClips = (payload: StartClipsPayload) =>
  request<{ job: Job; video_id: string }>('/api/clips', { method: 'POST', body: payload })

export const getJob = (jobId: string) =>
  request<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`).then((data) => data.job)

export const cancelJob = (jobId: string) =>
  request<{ cancelling: string }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })

export const retryJob = (jobId: string) =>
  request<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' })

export const listJobs = () =>
  request<{ jobs: Job[] }>('/api/jobs').then((data) => data.jobs ?? [])

/** SSE endpoint for a job. Same-origin by default; absolute when configured. */
export const jobEventsUrl = (jobId: string) =>
  clipSrc(`/api/jobs/${encodeURIComponent(jobId)}/events`)

export const jobLogs = (jobId: string) =>
  request<{ job: Job & { log?: JobLogEntry[] } }>(`/api/jobs/${encodeURIComponent(jobId)}`).then(
    (data) => data.job.log ?? [],
  )

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------
export const listClips = (params: { video_id?: string; limit?: number } = {}) => {
  const search = new URLSearchParams()
  if (params.video_id) search.set('video_id', params.video_id)
  if (params.limit) search.set('limit', String(params.limit))
  const query = search.toString()
  return request<{ clips: Clip[] }>(`/api/clips${query ? `?${query}` : ''}`).then(
    (data) => data.clips ?? [],
  )
}

export const getClip = (clipId: string) =>
  request<{ clip: Clip }>(`/api/clips/${encodeURIComponent(clipId)}`).then((d) => d.clip)

/** Trim, keep/drop, or retitle. Metadata only — no re-encode. */
export const patchClip = (clipId: string, patch: Partial<Pick<Clip, 'status' | 'start' | 'end' | 'title'>>) =>
  request<{ clip: Clip }>(`/api/clips/${encodeURIComponent(clipId)}`, {
    method: 'PATCH',
    body: patch,
  }).then((d) => d.clip)

export const clipWords = (clipId: string) =>
  request<{ words: WordTiming[] }>(`/api/clips/${encodeURIComponent(clipId)}/words`).then(
    (d) => d.words ?? [],
  )

export const clipSrtUrl = (clipId: string) => clipSrc(`/api/clips/${encodeURIComponent(clipId)}/srt`)

export const uploadClipSubtitle = (clipId: string, file: File) => {
  const form = new FormData()
  form.append('subtitle', file)
  return request<{ clip_id: string; subtitle: string }>(
    `/api/clips/${encodeURIComponent(clipId)}/subtitle`,
    { method: 'POST', form },
  )
}

export const deleteClip = (clipId: string) =>
  request<{ deleted: string }>(`/api/clips/${encodeURIComponent(clipId)}`, { method: 'DELETE' })

export const clearClips = () => request<{ deleted: number }>('/api/clips/clear', { method: 'POST' })

export interface RenderOptions {
  aspect_ratio?: string
  caption_style?: string
  captions?: boolean
}

/** Re-encode one clip at a given ratio/style. Returns a job. */
export const renderClip = (clipId: string, options: RenderOptions = {}) =>
  request<{ job: Job }>(`/api/clips/${encodeURIComponent(clipId)}/render`, {
    method: 'POST',
    body: options,
  })

/** Re-encode several clips in one job. Defaults to every kept clip. */
export const renderClips = (payload: { clip_ids?: string[]; status?: string } & RenderOptions = {}) =>
  request<{ job: Job; clip_ids: string[] }>('/api/clips/render', { method: 'POST', body: payload })

// ---------------------------------------------------------------------------
// Library / videos
// ---------------------------------------------------------------------------
export const listProjects = (params: { empty?: boolean } = {}) => {
  const search = params.empty === undefined ? '' : `?empty=${params.empty ? '1' : '0'}`
  return request<{ projects: Project[] }>(`/api/projects${search}`).then((d) => d.projects ?? [])
}

export const getProject = (videoId: string) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(videoId)}`)

export const listTranscripts = () =>
  request<{ transcripts: { video_id: string; size: number; modified_at: number }[] }>(
    '/api/transcripts',
  ).then((d) => d.transcripts ?? [])

export const getTranscript = (videoId: string) =>
  request<{ transcript: unknown }>(`/api/transcript/${encodeURIComponent(videoId)}`).then(
    (d) => d.transcript,
  )

export const getVideo = (videoId: string) =>
  request<{ video: Record<string, unknown> }>(`/api/video/${encodeURIComponent(videoId)}`).then(
    (d) => d.video,
  )

export const deleteVideo = (videoId: string) =>
  request<{ deleted: string }>(`/api/video/${encodeURIComponent(videoId)}`, { method: 'DELETE' })
