import { useEffect, useRef, useState } from 'react'

import { getJob, jobEventsUrl } from '../lib/api'
import type { Job, JobLogEntry, JobStatus } from '../types'

const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'cancelled']

/**
 * Subscribe to a job's Server-Sent Event stream.
 *
 * Chosen over polling because a render reports progress several times a second;
 * at any poll interval worth having, the bar visibly sticks between updates.
 * EventSource also reconnects on its own and the backend replays a snapshot on
 * every connection, so a dropped connection self-heals without retry logic here.
 *
 * The one thing worth guarding is a terminal state: once a job is finished there
 * is nothing left to stream, and an open connection would just churn heartbeats.
 */
export function useJobStream(jobId: string | undefined) {
  const [job, setJob] = useState<Job | null>(null)
  const [connected, setConnected] = useState(false)
  const [log, setLog] = useState<JobLogEntry[]>([])
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!jobId) return undefined

    let cancelled = false
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      sourceRef.current?.close()
      sourceRef.current = null
      setConnected(false)
    }

    // Fetch once up front so the screen renders immediately rather than waiting
    // for the stream's first frame.
    getJob(jobId)
      .then((initial) => {
        if (!cancelled && !closed) setJob(initial)
      })
      .catch(() => undefined)

    const source = new EventSource(jobEventsUrl(jobId))
    sourceRef.current = source

    source.onopen = () => {
      if (!cancelled) setConnected(true)
    }

    source.addEventListener('snapshot', (event) => {
      if (cancelled) return
      const data = JSON.parse((event as MessageEvent).data) as { job?: Job } & Job
      const next = data.job ?? data
      setJob(next)
      if (TERMINAL.includes(next.status)) close()
    })

    source.addEventListener('progress', (event) => {
      if (cancelled) return
      const data = JSON.parse((event as MessageEvent).data) as Pick<Job, 'progress' | 'stage'>
      setJob((current) =>
        current ? { ...current, status: 'running', progress: data.progress, stage: data.stage } : current,
      )
    })

    source.addEventListener('log', (event) => {
      if (cancelled) return
      const data = JSON.parse((event as MessageEvent).data) as JobLogEntry
      // Keep the tail only; the backend caps its own log and no screen shows more.
      setLog((current) => [...current, data].slice(-200))
    })

    const terminal = (status: JobStatus) => (event: Event) => {
      if (cancelled) return
      let payload: { error?: string; result?: Record<string, unknown> } = {}
      try {
        payload = JSON.parse((event as MessageEvent).data || '{}')
      } catch {
        payload = {}
      }
      setJob((current) =>
        current
          ? {
              ...current,
              status,
              error: payload.error ?? current.error ?? null,
              result: payload.result ?? current.result ?? null,
              progress: status === 'succeeded' ? 100 : current.progress,
            }
          : current,
      )
      close()
    }

    source.addEventListener('succeeded', terminal('succeeded'))
    source.addEventListener('failed', terminal('failed'))
    source.addEventListener('cancelled', terminal('cancelled'))

    source.onerror = () => {
      if (!cancelled) setConnected(false)
    }

    return () => {
      cancelled = true
      close()
    }
  }, [jobId])

  return { job, connected, log, setJob }
}
