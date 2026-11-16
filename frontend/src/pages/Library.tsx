import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { clipSrc, describeError, getProject, listProjects } from '../lib/api'
import type { ApiError } from '../lib/api'
import { formatDuration } from '../lib/format'
import type { Clip, Project } from '../types'
import ErrorNote from '../components/ErrorNote'
import PageHeader from '../components/PageHeader'
import { Button, Card, Empty, Hint, Tag, buttonClass } from '../components/ui'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

export default function Library() {
  useDocumentTitle('Library')
  const [params, setParams] = useSearchParams()
  const videoId = params.get('video')

  const [projects, setProjects] = useState<Project[] | null>(null)
  const [detail, setDetail] = useState<{ project: Project; clips: Clip[] } | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const records = await listProjects()
      setProjects(records)
      setError(null)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!videoId) {
      setDetail(null)
      return undefined
    }
    let alive = true
    getProject(videoId)
      .then((data) => alive && setDetail(data))
      .catch((err) => alive && setError(describeError(err)))
    return () => {
      alive = false
    }
  }, [videoId])

  return (
    <>
      <PageHeader
        title="Library"
        subtitle={projects ? `${projects.length} video${projects.length === 1 ? '' : 's'} on disk` : 'Loading…'}
        actions={
          <Button size="sm" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        }
      />

      {error && <ErrorNote error={error} onDismiss={() => setError(null)} />}

      {!videoId && (
        <>
          {loading && !projects && (
            <Card>
              <Hint>Loading…</Hint>
            </Card>
          )}

          {projects?.length === 0 && (
            <Empty title="Nothing rendered yet.">
              <p>Clips appear here automatically once a job finishes.</p>
              <Link to="/" className={buttonClass('primary', 'md', 'mt-4')}>
                Start a video
              </Link>
            </Empty>
          )}

          {projects && projects.length > 0 && (
            <Card className="p-0">
              <ul>
                {projects.map((project) => (
                  <li key={project.video_id}>
                    <Link
                      to={`/library?video=${encodeURIComponent(project.video_id)}`}
                      className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-ink-850 px-2 py-4 no-underline transition-colors last:border-b-0 hover:bg-ink-850/50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[0.9375rem] text-ink-200">{project.title}</span>
                        <span className="mt-0.5 block text-xs text-ink-300 numeric">
                          {[
                            project.duration ? formatDuration(project.duration) : null,
                            project.clip_count
                              ? `${project.clip_count} clip${project.clip_count === 1 ? '' : 's'}`
                              : 'no clips',
                            project.kept_count ? `${project.kept_count} kept` : null,
                            project.has_transcript ? 'transcribed' : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <Tag tone="muted">{project.clip_count ? 'open' : 'run'}</Tag>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {videoId && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => setParams({})}>
              ← All videos
            </Button>
            <Link
              to={`/library?video=${encodeURIComponent(videoId)}`}
              className={buttonClass('ghost', 'sm', 'sm:ml-auto')}
            >
              Open in review
            </Link>
          </div>

          <h2 className="font-display text-2xl text-ink-100">{detail?.project?.title || videoId}</h2>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-10 gap-y-6">
            {detail?.clips?.map((clip) => (
              <figure key={clip.id} className="m-0">
                {clip.poster_url ? (
                  <img
                    src={clipSrc(clip.poster_url)}
                    alt=""
                    className="aspect-[9/16] w-full border border-ink-800 bg-ink-850 object-cover"
                  />
                ) : (
                  <div className="aspect-[9/16] w-full border border-ink-800 bg-ink-850" />
                )}
                <figcaption className="mt-1.5 text-xs text-ink-300 numeric">
                  {formatDuration(clip.duration)}
                  {clip.status === 'kept' && <span className="text-sodium-500"> kept</span>}
                  {clip.captions && <span className="text-good"> captions</span>}
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </>
  )
}
