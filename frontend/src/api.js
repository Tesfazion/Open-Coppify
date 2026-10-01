import axios from 'axios'

// Point at the Flask backend. Override with VITE_API_URL in frontend/.env.
export const API_BASE =
  (import.meta.env?.VITE_API_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '')

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

/** Turn any axios failure into a readable message for the UI. */
export function describeError(error) {
  if (axios.isCancel?.(error)) return 'Request cancelled.'
  const data = error?.response?.data
  if (data?.error) return data.error
  if (error?.code === 'ECONNABORTED') {
    return 'The backend took too long to respond.'
  }
  if (error?.message === 'Network Error' || error?.code === 'ERR_NETWORK') {
    return `Cannot reach the backend at ${API_BASE}. Is it running? Start it with "python app.py" in backend/.`
  }
  return error?.message || 'Something went wrong.'
}

// ---------------------------------------------------------------------------
// Health / config
// ---------------------------------------------------------------------------
export const getHealth = () => client.get('/api/health').then((r) => r.data)
export const getConfig = () => client.get('/api/config').then((r) => r.data)

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export const startDownload = (payload) =>
  client.post('/api/download', payload).then((r) => r.data)

export const startTranscribe = (payload) =>
  client.post('/api/transcribe', payload).then((r) => r.data)

export const startClips = (payload) =>
  client.post('/api/clips', payload).then((r) => r.data)

export const getJob = (jobId) =>
  client.get(`/api/jobs/${jobId}`).then((r) => r.data.job)

export const cancelJob = (jobId) =>
  client.post(`/api/jobs/${jobId}/cancel`).then((r) => r.data)

// ---------------------------------------------------------------------------
// Clips / video / transcripts
// ---------------------------------------------------------------------------
export const listClips = (params = {}) =>
  client.get('/api/clips', { params }).then((r) => r.data)

export const deleteClip = (clipId) =>
  client.delete(`/api/clips/${clipId}`).then((r) => r.data)

export const getTranscript = (videoId) =>
  client.get(`/api/transcript/${videoId}`).then((r) => r.data)

export const getVideo = (videoId) =>
  client.get(`/api/video/${videoId}`).then((r) => r.data)

export const deleteVideo = (videoId) =>
  client.delete(`/api/video/${videoId}`).then((r) => r.data)

/**
 * Absolute URL for a clip, so <video src> works regardless of which host
 * served the gallery JSON.
 */
export const clipSrc = (path) => {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
}

export default client