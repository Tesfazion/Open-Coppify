import { useState } from 'react'
import { extractVideoId } from '../utils/youtube'

const PRESETS = [
  { label: 'Paste link', value: '' },
  { label: 'Short', value: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
]

export default function UrlForm({ url, onUrlChange, busy, onDownload, onTranscribe, onGenerate }) {
  const [touched, setTouched] = useState(false)
  const videoId = extractVideoId(url)
  const invalid = touched && url.trim().length > 0 && !videoId

  const submit = (event) => {
    event.preventDefault()
    setTouched(true)
    if (!videoId) return
    onGenerate()
  }

  return (
    <section className="card">
      <form onSubmit={submit}>
        <label className="label" htmlFor="youtube-url">
          YouTube link
        </label>

        <div className="url-row">
          <input
            id="youtube-url"
            className={`input ${invalid ? 'input--error' : ''}`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck="false"
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            disabled={busy}
            onChange={(event) => {
              onUrlChange(event.target.value)
              setTouched(true)
            }}
          />
          <button className="btn btn--primary" type="submit" disabled={busy || !videoId}>
            Generate clips
          </button>
        </div>

        <div className="url-meta">
          {videoId ? (
            <span className="pill pill--ok">video id {videoId}</span>
          ) : invalid ? (
            <span className="pill pill--bad">
              That does not look like a single YouTube video link.
            </span>
          ) : (
            <span className="hint">
              Works with watch, youtu.be, /shorts/, /live/ and /embed/ links.
            </span>
          )}

          <span className="presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="link-btn"
                disabled={busy}
                onClick={() => onUrlChange(preset.value)}
              >
                {preset.label === 'Paste link' ? 'clear' : `example: ${preset.label}`}
              </button>
            ))}
          </span>
        </div>

        <div className="stage-buttons">
          <span className="stage-buttons__label">Run a single step:</span>
          <button className="btn btn--ghost" type="button" disabled={busy || !videoId} onClick={onDownload}>
            1. Download
          </button>
          <button className="btn btn--ghost" type="button" disabled={busy || !videoId} onClick={onTranscribe}>
            2. Transcribe
          </button>
          <button className="btn btn--ghost" type="button" disabled={busy || !videoId} onClick={onGenerate}>
            3. Cut clips
          </button>
          <p className="hint hint--block">
            Each button downloads and transcribes on demand if that step has not
            run yet, so you can use them independently or in order.
          </p>
        </div>
      </form>
    </section>
  )
}