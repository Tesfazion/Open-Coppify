import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { cancelJob, describeError, retryJob } from '../lib/api'
import { cn } from '../lib/cn'
import { formatDuration } from '../lib/format'
import { useJobStream } from '../hooks/useJobStream'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import ErrorNote from '../components/ErrorNote'
import PageHeader from '../components/PageHeader'
import { Button, Card, Empty, Eyebrow, Tag, buttonClass } from '../components/ui'
import type { Job } from '../types'

const STAGES = [
  { key: 'download', label: 'Download' },
  { key: 'transcribe', label: 'Transcribe' },
  { key: 'clips', label: 'Cut' },
] as const

/**
 * Live progress for one job.
 *
 * Its own screen because the work it waits on is long and unpredictable: a long
 * video on CPU spends most of its time in Whisper, and a single-page layout
 * gives that nowhere to live. Progress arrives over SSE rather than polling so
 * the bar tracks several updates a second.
 */
export default function JobProgress() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const { job, connected, log } = useJobStream(jobId)
  const [error, setError] = useState<ReturnType<typeof describeError> | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  useDocumentTitle(job ? `Job ${job.id.slice(0, 8)}` : 'Job')

  const terminal = useMemo(
    () => Boolean(job && ['succeeded', 'failed', 'cancelled'].includes(job.status)),
    [job],
  )

  // Follow the tail, but only when already near it — yanking the view back while
  // someone reads an earlier line is worse than not following at all.
  useEffect(() => {
    const node = logRef.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distance < 120) node.scrollTop = node.scrollHeight
  }, [log])

  const onCancel = async () => {
    if (!jobId) return
    try {
      await cancelJob(jobId)
    } catch (err) {
      setError(describeError(err))
    }
  }

  const onRetry = async () => {
    if (!jobId) return
    setError(null)
    try {
      const data = await retryJob(jobId)
      navigate(`/jobs/${data.job.id}`, { replace: true })
    } catch (err) {
      setError(describeError(err))
    }
  }

  if (!job) {
    return (
      <Empty title="Looking for that job…">
        <p>
          If it is not listed here, the backend has probably restarted, which clears the
          in-memory job registry.
        </p>
      </Empty>
    )
  }

  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0))
  const videoId = (job.params?.video_id as string) || (job.result?.video_id as string) || undefined
  const title = (job.result?.title as string) || (job.params?.title as string) || undefined

  return (
    <>
      <PageHeader
        title={title || videoId || `Job ${job.id.slice(0, 8)}`}
        subtitle={`${job.type} job`}
        actions={
          <>
            <Tag tone={connected ? 'good' : 'muted'} role="status">
              {connected ? 'live' : terminal ? 'closed' : 'connecting'}
            </Tag>
            {!terminal && (
              <Button size="sm" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      <div className="max-w-[38rem]">
        <div className="flex items-baseline gap-4">
          <p className="font-display numeric text-[clamp(3rem,9vw,5rem)] leading-none text-ink-100">
            {Math.round(progress)}
            <span className="text-[0.4em] text-ink-400">%</span>
          </p>
          <span className="ml-auto text-xs text-ink-300 numeric">
            {formatDuration(job.elapsed)} elapsed
          </span>
        </div>

        <div
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Job progress"
          className="relative mt-4 h-0.5 bg-ink-800"
        >
          <div
            className={cn('h-full bg-sodium-500 transition-[width] duration-300 ease-out', !terminal && 'sweep')}
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="mt-3 flex items-center gap-3">
          <Tag tone={terminal ? 'muted' : 'accent'} className={terminal ? undefined : 'pulsing'}>
            {job.status}
          </Tag>
          <span className="text-xs text-ink-300">{job.stage}</span>
        </p>
      </div>

      <ol className="mt-6 max-w-[38rem] border-t border-ink-800">
        {STAGES.map((stage) => {
          const done = job.status === 'succeeded' || hasReached(job, stage.key)
          return (
            <li key={stage.key} className="flex items-center gap-3 border-b border-ink-800 px-2 py-2.5">
              <Tag tone={done ? 'good' : 'muted'}>{done ? 'done' : 'wait'}</Tag>
              <span className={cn('text-sm', done ? 'text-ink-200' : 'text-ink-400')}>{stage.label}</span>
            </li>
          )
        })}
      </ol>

      {error && (
        <div className="max-w-[38rem]">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {job.status === 'failed' && (
        <div className="max-w-[38rem]">
          <ErrorNote
            error={{ message: job.error || 'The job failed.' }}
            action={
              <Button variant="primary" size="sm" onClick={onRetry}>
                Run it again
              </Button>
            }
          />
          <p className="mt-2 text-xs text-ink-300">
            Retrying issues a new job id, so this tab follows the new attempt rather than rewinding
            the old one.
          </p>
        </div>
      )}

      {job.status === 'succeeded' && (
        <div className="flex flex-wrap items-center gap-3">
          {videoId ? (
            <Link to={`/library?video=${encodeURIComponent(videoId)}`} className={buttonClass('primary')}>
              Review {job.result?.clip_count ? String(job.result.clip_count) : 'the'} clips
            </Link>
          ) : (
            <Link to="/library" className={buttonClass('primary')}>
              Open library
            </Link>
          )}
          <Link to="/" className={buttonClass('quiet')}>
            Start another
          </Link>
        </div>
      )}

      {job.status === 'cancelled' && (
        <p className="max-w-[38rem] border-l-2 border-sodium-600 pl-4 text-sm leading-relaxed text-ink-300">
          Cancelled. Nothing was written to the library.
        </p>
      )}

      {log.length > 0 && (
        <Card className="max-w-[38rem]">
          <Eyebrow as="h2">Log ({log.length})</Eyebrow>
          <pre
            ref={logRef}
            className="numeric max-h-72 overflow-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-900 p-4 text-xs leading-relaxed text-ink-200"
          >
            {log.map((entry, index) => (
              <div key={index} className={entry.level === 'error' ? 'text-bad' : undefined}>
                {entry.message}
              </div>
            ))}
          </pre>
        </Card>
      )}
    </>
  )
}

/**
 * Which stages a job has passed.
 *
 * Derived from the stage string rather than a counter, because a job can skip
 * stages (a cached transcript) and re-enter them (a clip re-render). A fixed
 * checklist would claim work that never happened.
 */
function hasReached(job: Job, key: (typeof STAGES)[number]['key']): boolean {
  const stage = String(job.stage || '').toLowerCase()
  const words: Record<string, string[]> = {
    download: ['download', 'fetch', 'video'],
    transcribe: ['transcri', 'whisper', 'speech'],
    clips: ['clip', 'cut', 'encode', 'render'],
  }
  return words[key].some((word) => stage.includes(word)) && Number(job.progress) > 0
}
