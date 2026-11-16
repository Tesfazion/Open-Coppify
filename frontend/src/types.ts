/**
 * Shapes returned by the Flask API.
 *
 * These mirror the JSON the backend actually emits (see backend/routes/api.py
 * and the service layer). Fields the backend may omit are optional so a
 * partially-completed clip or job still type-checks at the edges.
 */

export type ClipStatus = 'candidate' | 'kept' | 'discarded'

export interface Clip {
  id: string
  video_id?: string
  index?: number
  title?: string
  filename: string
  status: ClipStatus
  start: number
  end: number
  duration: number
  score?: number
  reasons?: string[]
  excerpt?: string
  aspect_ratio: string
  vertical_mode?: string
  width?: number
  height?: number
  size?: number
  captions?: boolean
  has_captions?: boolean
  caption_style?: string
  user_trimmed?: boolean
  url: string
  poster_url?: string | null
  download_url: string
  thumbnail_url?: string | null
}

export interface WordTiming {
  word: string
  start: number
  end: number
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobLogEntry {
  message: string
  level?: string
  ts?: number
}

export interface Job {
  id: string
  type: string
  status: JobStatus
  stage?: string
  progress: number
  elapsed?: number
  error?: string | null
  result?: Record<string, unknown> | null
  params?: Record<string, unknown>
  created_at?: number
  updated_at?: number
}

export interface Project {
  video_id: string
  title: string
  duration?: number
  clip_count?: number
  kept_count?: number
  has_transcript?: boolean
  thumbnail?: string | null
  uploader?: string | null
  webpage_url?: string | null
  modified_at?: number
}

export interface ProjectDetail {
  project: Project
  clips: Clip[]
}

export interface CaptionStyle {
  key: string
  label: string
  description?: string
}

export interface WhisperModel {
  name: string
  note?: string
}

export interface Settings {
  clip_count: number
  min_seconds: number
  max_seconds: number
  target_seconds: number
  keywords: string
  vertical_mode: string
  captions: boolean
  auto_transcribe: boolean
  whisper_model: string
  aspect_ratio: string
  caption_style: string
}

export interface SettingsResponse {
  settings: Settings
  aspect_ratios?: string[]
  vertical_modes?: string[]
  whisper_models?: WhisperModel[]
  caption_styles?: CaptionStyle[]
  limits?: Record<string, [number, number]>
  path?: string
}

export interface ComponentStatus {
  ok?: boolean
  version?: string
  backend?: string
  device?: string
  cuda?: boolean
  error?: string
}

export interface Health {
  ok: boolean
  ffmpeg?: ComponentStatus
  ffprobe?: ComponentStatus
  whisper?: ComponentStatus & { model?: string; torch?: string }
  ytdlp_version?: string | null
  clips_dir?: string
  clips_on_disk?: number
  limits?: Record<string, number>
  whisper_models?: WhisperModel[]
}
