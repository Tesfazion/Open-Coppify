import { useCallback, useEffect, useRef, useState } from 'react'
import { cancelJob, describeError, getJob } from '../api'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

const EMPTY = {
  id: null,
  type: null,
  status: 'idle',
  progress: 0,
  stage: '',
  result: null,
  error: null,
  logs: [],
}

/**
 * Drives one backend job to completion by polling /api/jobs/<id>.
 *
 * The backend runs long stages (Whisper loading, FFmpeg encoding) on worker
 * threads, so the UI polls rather than holding a single open request. Polling
 * backs off from 600ms to 3s so a long render does not hammer the API.
 */
export function useJob(onSettled) {
  const [job, setJob] = useState(EMPTY)
  const [isRunning, setIsRunning] = useState(false)

  const timerRef = useRef(null)
  const aliveRef = useRef(true)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setJob(EMPTY)
    setIsRunning(false)
  }, [])

  const track = useCallback((started, type) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const id = started?.job?.id
    if (!id) {
      setJob({
        ...EMPTY,
        status: 'failed',
        error: 'The backend did not return a job id.',
      })
      setIsRunning(false)
      return
    }

    const seed = started.job
    setJob({
      ...EMPTY,
      id,
      type,
      status: seed.status || 'queued',
      progress: seed.progress || 0,
      stage: seed.stage || 'Queued',
    })
    setIsRunning(true)

    let elapsed = 0

    const tick = async () => {
      if (!aliveRef.current) return
      try {
        const next = await getJob(id)
        if (!aliveRef.current) return
        setJob(next)
        if (TERMINAL.has(next.status)) {
          setIsRunning(false)
          onSettledRef.current?.(next)
          return
        }
      } catch (error) {
        if (!aliveRef.current) return
        // Build the failed payload from current state rather than the value
        // captured when track() was called, which would be stale.
        const failedJob = {
          ...EMPTY,
          id,
          type,
          status: 'failed',
          stage: 'Polling failed',
          error: describeError(error),
        }
        setJob(failedJob)
        setIsRunning(false)
        onSettledRef.current?.(failedJob)
        return
      }
      // Back off from 600ms up to 3s.
      elapsed += 600
      timerRef.current = setTimeout(tick, Math.min(3000, elapsed))
    }

    timerRef.current = setTimeout(tick, 300)
  }, [])

  const cancel = useCallback(async () => {
    const id = job.id
    if (!id) return
    try {
      await cancelJob(id)
      setJob((current) => ({ ...current, stage: 'Cancelling...' }))
    } catch (error) {
      setJob((current) => ({ ...current, error: describeError(error) }))
    }
  }, [job.id])

  return { job, isRunning, track, cancel, reset }
}