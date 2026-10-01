import { useState } from 'react'
import { formatTimestamp } from '../utils/youtube'

/** Transcript with clickable segment timestamps. */
export default function TranscriptPanel({ transcript, videoId }) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(40)

  if (!transcript) return null

  const needle = query.trim().toLowerCase()
  const segments = (transcript.segments || []).filter((segment) =>
    needle ? (segment.text || '').toLowerCase().includes(needle) : true,
  )

  return (
    <section className="card">
      <div className="card__head">
        <h2>Transcript</h2>
        <div className="transcript__meta">
          <span className="pill pill--muted">
            {transcript.segments?.length || 0} segments
          </span>
          <span className="pill pill--muted">{transcript.word_count || 0} words</span>
          {transcript.language && (
            <span className="pill pill--muted">{transcript.language}</span>
          )}
          <span className="pill pill--muted">model: {transcript.model}</span>
        </div>
      </div>

      <input
        className="input"
        type="search"
        placeholder="Search the transcript..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {segments.length === 0 ? (
        <p className="hint">No segments match that search.</p>
      ) : (
        <>
          <ol className="transcript">
            {segments.slice(0, limit).map((segment) => (
              <li key={segment.id ?? `${segment.start}`} className="transcript__row">
                <a
                  className="transcript__time"
                  href={`https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(
                    segment.start,
                  )}s`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {formatTimestamp(segment.start)}
                </a>
                <span className="transcript__text">{segment.text}</span>
              </li>
            ))}
          </ol>

          {segments.length > limit && (
            <button
              className="btn btn--ghost btn--small"
              type="button"
              onClick={() => setLimit((current) => current + 60)}
            >
              Show more ({segments.length - limit} left)
            </button>
          )}
        </>
      )}
    </section>
  )
}