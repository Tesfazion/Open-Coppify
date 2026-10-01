import { useState } from 'react'
import { clipSrc } from '../api'
import { formatBytes, formatTimestamp } from '../utils/youtube'

function ClipCard({ clip, onDelete }) {
  const [error, setError] = useState(null)

  return (
    <article className="clip">
      <div className="clip__frame">
        <video
          className="clip__video"
          src={clipSrc(clip.url)}
          poster={clip.poster_url ? clipSrc(clip.poster_url) : undefined}
          controls
          playsInline
          preload="metadata"
          onError={() => setError('This clip could not be played in your browser.')}
        />
        {error && <p className="clip__error">{error}</p>}
        <span className="clip__badge">{formatTimestamp(clip.duration)}</span>
        <span className="clip__ratio">9:16</span>
      </div>

      <div className="clip__body">
        <div className="clip__row">
          <span className="clip__index">Clip {clip.index}</span>
          <span className="clip__size">{formatBytes(clip.size)}</span>
        </div>

        <p className="clip__time">
          source {formatTimestamp(clip.start)} &rarr; {formatTimestamp(clip.end)}
        </p>

        {clip.reasons?.length > 0 && (
          <div className="chips">
            {clip.reasons.slice(0, 3).map((reason, index) => (
              <span key={index} className="chip">
                {reason}
              </span>
            ))}
          </div>
        )}

        {clip.excerpt && <p className="clip__excerpt">&ldquo;{clip.excerpt.slice(0, 160)}&rdquo;</p>}

        <div className="clip__actions">
          <a
            className="btn btn--small btn--primary"
            href={clipSrc(clip.download_url)}
            download
          >
            Download
          </a>
          <a
            className="btn btn--small btn--ghost"
            href={clipSrc(clip.url)}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
          <button
            className="btn btn--small btn--danger"
            type="button"
            onClick={() => onDelete(clip.id)}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  )
}

export default function ClipGallery({ clips, loading, onDelete, onRefresh, title }) {
  if (loading) {
    return (
      <section className="card">
        <p className="hint">Loading clips...</p>
      </section>
    )
  }

  if (!clips.length) {
    return (
      <section className="card empty">
        <h2>No clips yet</h2>
        <p className="hint">
          Paste a YouTube link above and press <strong>Generate clips</strong>.
          Coppify downloads the video, transcribes it with Whisper, then cuts the
          strongest 30&ndash;60 second moments into 9:16 vertical videos.
        </p>
      </section>
    )
  }

  return (
    <section className="gallery-section">
      <div className="gallery-head">
        <h2>{title || `Clips (${clips.length})`}</h2>
        <button className="btn btn--ghost btn--small" type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="gallery">
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} onDelete={onDelete} />
        ))}
      </div>
    </section>
  )
}