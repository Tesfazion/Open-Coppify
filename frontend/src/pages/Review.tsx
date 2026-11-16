import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  clipSrc,
  deleteClip,
  describeError,
  getProject,
  listProjects,
  patchClip,
  renderClips,
} from '../lib/api'
import type { ApiError } from '../lib/api'
import { cn } from '../lib/cn'
import { formatBytes, formatDuration } from '../lib/format'
import type { Clip, ClipStatus, Project } from '../types'
import ClipPlayer, { type Trim } from '../components/ClipPlayer'
import ErrorNote from '../components/ErrorNote'
import PageHeader from '../components/PageHeader'
import SubtitleManager from '../components/SubtitleManager'
import TranscriptPanel from '../components/TranscriptPanel'
import { Button, Card, Empty, Eyebrow, Hint, Tag, buttonClass } from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

const STATUSES: { value: ClipStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'candidate', label: 'Unreviewed' },
  { value: 'kept', label: 'Kept' },
  { value: 'discarded', label: 'Discarded' },
]

/**
 * Review and curate one video's clips.
 *
 * Curation is the whole point of the tool, so it lives here: each clip is kept
 * or dropped, its in/out points can be pulled in, and only what survives is
 * exported. Trim edits deliberately do not re-encode — dragging a handle should
 * feel instant; the encode is requested explicitly, as a job.
 */
export default function Review() {
  useDocumentTitle('Review')
  const [params, setParams] = useSearchParams()
  const videoId = params.get('video')

  const [project, setProject] = useState<Project | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [loading, setLoading] = useState(Boolean(videoId))
  const [error, setError] = useState<ApiError | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<ClipStatus | 'all'>('all')
  const [busy, setBusy] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Trim>>({})

  useEffect(() => {
    if (!videoId) {
      setProject(null)
      setClips([])
      setLoading(false)
      return undefined
    }
    let alive = true
    setLoading(true)
    getProject(videoId)
      .then((data) => {
        if (!alive) return
        setProject(data.project)
        setClips(data.clips || [])
        setSelected((current) => current ?? (data.clips || [])[0]?.id ?? null)
        setError(null)
      })
      .catch((err) => alive && setError(describeError(err)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [videoId])

  const patch = useCallback(async (clipId: string, changes: Partial<Pick<Clip, 'status' | 'start' | 'end' | 'title'>>) => {
    // Optimistic: keep/drop must feel instant; roll back only if the server disagrees.
    setClips((current) => current.map((clip) => (clip.id === clipId ? { ...clip, ...changes } : clip)))
    try {
      const data = await patchClip(clipId, changes)
      setClips((current) => current.map((clip) => (clip.id === clipId ? data : clip)))
      setError(null)
      return data
    } catch (err) {
      setClips((current) => current.map((clip) => (clip.id === clipId ? { ...clip, ...changes } : clip)))
      setError(describeError(err))
      throw err
    }
  }, [])

  const visible = useMemo(
    () => (filter === 'all' ? clips : clips.filter((clip) => clip.status === filter)),
    [clips, filter],
  )

  const current = clips.find((clip) => clip.id === selected) || visible[0] || null
  const draft: Trim | null = current
    ? drafts[current.id] ?? { start: current.start, end: current.end }
    : null
  const trimDirty = Boolean(current && draft && (draft.start !== current.start || draft.end !== current.end))
  const kept = clips.filter((clip) => clip.status === 'kept')

  const setDraft = (clipId: string, next: Trim) =>
    setDrafts((all) => ({ ...all, [clipId]: next }))

  const saveTrim = async () => {
    if (!current || !draft || !trimDirty) return
    setBusy(true)
    try {
      await patch(current.id, { start: draft.start, end: draft.end })
      setDrafts((all) => {
        const next = { ...all }
        delete next[current.id]
        return next
      })
    } catch {
      /* patch() already surfaced the error */
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (clipId: string, status: ClipStatus) => {
    try {
      await patch(clipId, { status })
    } catch {
      /* surfaced */
    }
  }

  const remove = async (clipId: string) => {
    setBusy(true)
    try {
      await deleteClip(clipId)
      setClips((current) => current.filter((clip) => clip.id !== clipId))
      setSelected((current) => (current === clipId ? null : current))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const exportKept = async () => {
    if (!kept.length) return
    setBusy(true)
    try {
      await renderClips({ clip_ids: kept.map((clip) => clip.id) })
      setError(null)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  if (!videoId) return <ProjectPicker />

  if (loading) return <Hint className="pt-12">Loading…</Hint>

  if (!clips.length) {
    return (
      <Empty title="No clips on this one.">
        <p>{project?.title || videoId} has nothing rendered yet.</p>
        <Link to={`/?video=${encodeURIComponent(videoId)}`} className={buttonClass('primary', 'md', 'mt-4')}>
          Run it
        </Link>
      </Empty>
    )
  }

  return (
    <>
      <PageHeader
        title={project?.title || videoId}
        subtitle={`${clips.length} clips · ${kept.length} kept${
          project?.duration ? ` · source ${formatDuration(project.duration)}` : ''
        }`}
        actions={
          <>
            <Button size="sm" onClick={() => setParams({})}>
              All videos
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={exportKept}
              disabled={busy || !kept.length}
              title={kept.length ? 'Re-render every kept clip' : 'Keep at least one clip first'}
            >
              {busy ? 'Working…' : `Render kept (${kept.length})`}
            </Button>
          </>
        }
      />

      {error && <ErrorNote error={error} onDismiss={() => setError(null)} />}

      <div className="flex flex-wrap items-center gap-3">
        {STATUSES.map((status) => (
          <button
            key={status.value}
            type="button"
            aria-pressed={filter === status.value}
            onClick={() => setFilter(status.value)}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-semibold',
              filter === status.value ? 'text-sodium-500' : 'text-ink-300 hover:text-ink-100',
            )}
          >
            {status.label}
            <span className="ml-2 text-ink-400 numeric">
              {status.value === 'all' ? clips.length : clips.filter((clip) => clip.status === status.value).length}
            </span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Player column */}
        <div>
          {current && draft ? (
            <div className="flex flex-col gap-5">
              <ClipPlayer
                clip={current}
                trim={draft}
                onTrimChange={(next) => setDraft(current.id, next)}
              />

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" size="sm" onClick={saveTrim} disabled={!trimDirty || busy}>
                  Save trim
                </Button>
                {trimDirty && (
                  <Button
                    size="sm"
                    onClick={() =>
                      setDrafts((all) => {
                        const next = { ...all }
                        delete next[current.id]
                        return next
                      })
                    }
                  >
                    discard
                  </Button>
                )}
                <Tag tone="muted" className="numeric sm:ml-auto">
                  {formatDuration(draft.end - draft.start)} long · {current.aspect_ratio} · {formatBytes(current.size)}
                </Tag>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant={current.status === 'kept' ? 'primary' : 'ghost'}
                  size="sm"
                  aria-pressed={current.status === 'kept'}
                  onClick={() => setStatus(current.id, current.status === 'kept' ? 'candidate' : 'kept')}
                >
                  {current.status === 'kept' ? 'Kept ✓' : 'Keep'}
                </Button>
                <Button
                  variant={current.status === 'discarded' ? 'danger' : 'ghost'}
                  size="sm"
                  aria-pressed={current.status === 'discarded'}
                  onClick={() => setStatus(current.id, current.status === 'discarded' ? 'candidate' : 'discarded')}
                >
                  Discard
                </Button>
                <span className="sm:ml-auto" />
                <a className={buttonClass('ghost', 'sm')} href={clipSrc(current.download_url)} download>
                  Download
                </a>
                <Button variant="danger" size="sm" onClick={() => remove(current.id)} disabled={busy}>
                  Delete
                </Button>
              </div>

              <Tabs
                current={current}
                trim={draft}
                onSeek={(seconds) => {
                  const video = document.querySelector('video')
                  if (video) video.currentTime = Math.max(draft.start, Math.min(draft.end, seconds))
                }}
                onTrimChange={(next) => setDraft(current.id, next)}
                onCaptionUpdated={(clipId) =>
                  setClips((all) =>
                    all.map((clip) => (clip.id === clipId ? { ...clip, captions: true } : clip)),
                  )
                }
              />
            </div>
          ) : (
            <Hint>Pick a clip.</Hint>
          )}
        </div>

        {/* Clip list column */}
        <div>
          <Eyebrow as="h2" className="mb-3">
            Clips
          </Eyebrow>
          <ul className="border-t border-ink-800">
            {visible.map((clip) => (
              <li key={clip.id}>
                <ClipRow
                  clip={clip}
                  active={clip.id === current?.id}
                  onSelect={() => setSelected(clip.id)}
                  onKeep={() => setStatus(clip.id, clip.status === 'kept' ? 'candidate' : 'kept')}
                />
              </li>
            ))}
          </ul>
          {!visible.length && <Hint className="mt-4">Nothing in this view.</Hint>}
        </div>
      </div>
    </>
  )
}

function Tabs({
  current,
  trim,
  onSeek,
  onTrimChange,
  onCaptionUpdated,
}: {
  current: Clip
  trim: Trim
  onSeek: (seconds: number) => void
  onTrimChange: (next: Trim) => void
  onCaptionUpdated: (clipId: string) => void
}) {
  const [tab, setTab] = useState<'transcript' | 'subtitle' | 'why' | 'output'>('transcript')
  const tabs = [
    { key: 'transcript', label: 'Transcript' },
    { key: 'subtitle', label: 'Subtitles' },
    { key: 'why', label: 'Why this cut' },
    { key: 'output', label: 'Output' },
  ] as const

  return (
    <div className="mt-4">
      <div role="tablist" aria-label="Clip details" className="flex gap-6 border-b border-ink-800">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`panel-${entry.key}`}
            onClick={() => setTab(entry.key)}
            className={cn(
              'mb-[-1px] border-b-2 px-0 py-2 text-xs font-semibold',
              tab === entry.key
                ? 'border-b-sodium-500 text-ink-100'
                : 'border-b-transparent text-ink-300 hover:text-ink-100',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="pt-5"
      >
        {tab === 'transcript' && (
          <TranscriptPanel clip={current} trim={trim} onSeek={onSeek} onTrimChange={onTrimChange} />
        )}
        {tab === 'subtitle' && (
          <div className="flex flex-col gap-5">
            <div>
              <Eyebrow as="h3" className="mb-2">
                Current subtitle
              </Eyebrow>
              {current.captions ? (
                <div className="flex flex-col gap-2">
                  <Tag tone="good">burned into clip</Tag>
                  <Hint>Style: {current.caption_style || 'default'}</Hint>
                </div>
              ) : (
                <Hint>No subtitles are attached to this clip.</Hint>
              )}
            </div>
            <SubtitleManager clip={current} onUpdated={onCaptionUpdated} />
          </div>
        )}
        {tab === 'why' && (
          <div className="flex flex-col gap-3">
            {current.reasons?.length ? (
              <ul className="list-disc pl-5 text-sm leading-relaxed text-ink-200">
                {current.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            ) : (
              <Hint>No scoring notes were recorded for this clip.</Hint>
            )}
            {current.excerpt && (
              <blockquote className="border-l border-ink-600 pl-4 text-sm leading-relaxed text-ink-300">
                {current.excerpt}
              </blockquote>
            )}
          </div>
        )}
        {tab === 'output' && (
          <dl className="numeric grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[0.8125rem]">
            <dt className="text-ink-300">Frame</dt>
            <dd className="text-ink-200">
              {current.width}×{current.height} ({current.aspect_ratio})
            </dd>
            <dt className="text-ink-300">Framing</dt>
            <dd className="text-ink-200">{current.vertical_mode}</dd>
            <dt className="text-ink-300">Captions</dt>
            <dd className="text-ink-200">{current.captions ? current.caption_style : 'none'}</dd>
            <dt className="text-ink-300">Score</dt>
            <dd className="text-ink-200">{Number(current.score || 0).toFixed(2)}</dd>
            <dt className="text-ink-300">File</dt>
            <dd className="break-all text-ink-200">{current.filename}</dd>
          </dl>
        )}
      </div>
    </div>
  )
}

function ClipRow({
  clip,
  active,
  onSelect,
  onKeep,
}: {
  clip: Clip
  active: boolean
  onSelect: () => void
  onKeep: () => void
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_auto] items-center gap-3 border-b border-ink-850 border-l-2 p-2',
        active ? 'border-l-sodium-500' : 'border-l-transparent',
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-3 border-0 bg-transparent p-0 text-left text-inherit">
        {clip.poster_url && (
          <img
            src={clipSrc(clip.poster_url)}
            alt=""
            className="h-16 w-9 shrink-0 bg-ink-800 object-cover"
          />
        )}
        <span className="min-w-0">
          <span
            className={cn(
              'block truncate text-[0.8125rem]',
              clip.status === 'discarded' ? 'text-ink-400 line-through' : 'text-ink-200',
            )}
          >
            {clip.title || `Clip ${clip.index}`}
          </span>
          <span className="block text-xs text-ink-300 numeric">
            {formatDuration(clip.duration)} · {clip.aspect_ratio}
            {clip.user_trimmed ? ' · trimmed' : ''}
          </span>
        </span>
      </button>

      <Button
        size="sm"
        variant="quiet"
        onClick={onKeep}
        aria-pressed={clip.status === 'kept'}
        aria-label={clip.status === 'kept' ? `Unkeep ${clip.title ?? 'clip'}` : `Keep ${clip.title ?? 'clip'}`}
      >
        <Tag tone={clip.status === 'kept' ? 'accent' : 'muted'}>
          {clip.status === 'kept' ? 'kept' : 'keep'}
        </Tag>
      </Button>
    </div>
  )
}

/** Video picker, shown when no video is selected. */
function ProjectPicker() {
  const [projects, setProjects] = useState<Project[] | null>(null)

  useEffect(() => {
    let alive = true
    listProjects()
      .then((records) => alive && setProjects(records))
      .catch(() => alive && setProjects([]))
    return () => {
      alive = false
    }
  }, [])

  if (!projects) return <Hint className="pt-12">Loading…</Hint>

  if (!projects.length) {
    return (
      <Empty title="Nothing here yet.">
        <p>Render something and it will show up here, grouped by source video.</p>
        <Link to="/" className={buttonClass('primary', 'md', 'mt-4')}>
          Start a video
        </Link>
      </Empty>
    )
  }

  return (
    <>
      <PageHeader title="Library" subtitle={`${projects.length} videos`} />
      <Card className="p-0">
        <ul>
          {projects.map((project) => (
            <li key={project.video_id}>
              <Link
                to={project.clip_count ? `/library?video=${encodeURIComponent(project.video_id)}` : '/'}
                className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-ink-850 px-2 py-4 no-underline transition-colors last:border-b-0 hover:bg-ink-850/50"
              >
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] text-ink-200">{project.title}</span>
                  <span className="mt-0.5 block text-xs text-ink-300 numeric">
                    {[
                      project.duration ? formatDuration(project.duration) : null,
                      project.clip_count ? `${project.clip_count} clips` : 'no clips',
                      project.kept_count ? `${project.kept_count} kept` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <Tag tone="muted">{project.clip_count ? 'review' : 'open'}</Tag>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}
