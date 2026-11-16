import { useState } from 'react'

import { describeError, uploadClipSubtitle } from '../lib/api'
import type { ApiError } from '../lib/api'
import type { Clip } from '../types'
import { Hint, Tag } from './ui'

/** Upload a replacement .srt sidecar for one clip. */
export default function SubtitleManager({
  clip,
  onUpdated,
}: {
  clip: Clip
  onUpdated?: (clipId: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await uploadClipSubtitle(clip.id, file)
      onUpdated?.(clip.id)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  return (
    <div className="mt-3">
      <label htmlFor="subtitle-file" className="mb-2 block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-300">
        Subtitles
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="subtitle-file"
            type="file"
            accept=".srt"
            onChange={onFileChange}
            disabled={uploading}
            className="text-xs text-ink-200 file:mr-3 file:rounded file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ink-100"
          />
          {uploading && <span className="text-xs text-ink-300">Uploading…</span>}
        </div>
        {clip.captions && <Tag tone="good">captions attached</Tag>}
        {error && (
          <p className="text-xs text-bad" role="alert">
            {error.message}
          </p>
        )}
        <Hint>Only .srt files are accepted. The file is stored next to the clip, on your machine.</Hint>
      </div>
    </div>
  )
}
