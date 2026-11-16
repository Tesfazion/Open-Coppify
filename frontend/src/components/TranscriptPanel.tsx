import { useEffect, useMemo, useState } from 'react'

import { clipWords } from '../lib/api'
import { formatTimestamp } from '../lib/format'
import type { Clip, WordTiming } from '../types'
import type { Trim } from './ClipPlayer'
import { Hint, Tag } from './ui'

/**
 * Word-level transcript for one clip.
 *
 * Loaded on demand rather than with the clip list: the timings are large and
 * fetching them for every card would make the gallery wait on data most clips
 * are never asked for. Each word is a button that seeks the player, which is
 * what makes this a transcript rather than a wall of text.
 */
export default function TranscriptPanel({
  clip,
  onSeek,
  trim,
  onTrimChange,
}: {
  clip: Clip
  onSeek: (seconds: number) => void
  trim: Trim
  onTrimChange: (next: Trim) => void
}) {
  const [words, setWords] = useState<WordTiming[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    clipWords(clip.id)
      .then((records) => {
        if (!alive) return
        setWords(records)
        setError(null)
      })
      .catch((err: Error) => {
        if (!alive) return
        setWords([])
        setError(err.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [clip.id])

  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!words) return []
    if (!needle) return words
    return words.filter((entry) => String(entry.word || '').toLowerCase().includes(needle))
  }, [words, needle])

  if (loading) return <Hint>Loading transcript…</Hint>

  if (error) {
    return (
      <div className="border-l-2 border-sodium-600 pl-4 text-sm leading-relaxed text-ink-300">
        No word timings for this clip. The transcript may predate this feature.
      </div>
    )
  }

  if (!words?.length) {
    return <Hint>This clip has no transcript. Try one with captions turned on.</Hint>
  }

  const start = trim.start
  const end = trim.end

  return (
    <div className="flex flex-col gap-3">
      <label className="sr-only" htmlFor="transcript-search">
        Search transcript words
      </label>
      <input
        id="transcript-search"
        type="search"
        placeholder="Find a word…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="w-full border-0 border-b border-ink-600 bg-transparent px-0.5 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-b-sodium-500 focus:outline-none"
      />

      <Hint>
        {needle
          ? `${visible.length} of ${words.length} words match.`
          : `${words.length} words · click any word to seek · shift-click to set the in point`}
      </Hint>

      <div className="max-h-[22rem] overflow-y-auto pr-1 text-[1.05rem] leading-loose">
        {visible.map((entry, index) => {
          const outside = entry.start < start || entry.end > end
          return (
            <button
              key={`${entry.start}-${index}`}
              type="button"
              title={`${formatTimestamp(entry.start)} → ${formatTimestamp(entry.end)}`}
              onClick={(event) => {
                onSeek(entry.start)
                // Shift-click sets the in point: the fastest way to trim a clip
                // to start on a given word.
                if (event.shiftKey) onTrimChange({ ...trim, start: entry.start })
              }}
              className={
                outside
                  ? 'border-0 bg-transparent p-0 text-ink-400 decoration-dotted underline-offset-4 hover:text-ink-200'
                  : 'border-0 bg-transparent p-0 text-ink-200 hover:text-sodium-400'
              }
            >
              {entry.word}{' '}
            </button>
          )
        })}
      </div>

      {needle && <Tag tone="muted">{visible.length} matches</Tag>}
    </div>
  )
}
