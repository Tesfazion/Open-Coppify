import { useCallback, useEffect, useMemo, useState } from 'react'

import ClipGallery from './components/ClipGallery'
import HealthBar from './components/HealthBar'
import OptionsPanel from './components/OptionsPanel'
import ProgressPanel from './components/ProgressPanel'
import TranscriptPanel from './components/TranscriptPanel'
import UrlForm from './components/UrlForm'
import {
  API_BASE,
  deleteClip,
  deleteVideo,
  describeError,
  getConfig,
  getHealth,
  getTranscript,
  getVideo,
  listClips,
  startClips,
  startDownload,
  startTranscribe,
} from './api'
import { useJob } from './hooks/useJob'
import { extractVideoId } from './utils/youtube'

const DEFAULT_OPTIONS = {
  count: 5,
  minSeconds: 30,
  maxSeconds: 60,
  targetSeconds: 45,
  keywords: '',
  verticalMode: 'blur',
  captions: true,
  autoTranscribe: true,
  model: 'base',
}

export default function App() {
  const [url, setUrl] = useState('')
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState(null)
  const [video, setVideo] = useState(null)
  const [transcript, setTranscript] = useState(null)
  const [clips, setClips] = useState([])
  const [clipsLoading, setClipsLoading] = useState(true)
  const [notice, setNotice] = useState(null)

  const videoId = useMemo(() => extractVideoId(url), [url])

  // -- data loaders ---------------------------------------------------------
  const loadConfig = useCallback(async () => {
    try {
      const data = await getConfig()
      if (data?.ok && data.defaults) {
        setOptions((current) => ({ ...current, ...data.defaults }))
      }
    } catch {
      // Backend config is optional; fall back to hard-coded defaults.
    }
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await getHealth())
      setHealthError(null)
    } catch (error) {
      setHealth(null)
      setHealthError(describeError(error))
    }
  }, [])

  const loadClips = useCallback(async (filterByVideo) => {
    setClipsLoading(true)
    try {
      const params = filterByVideo ? { video_id: filterByVideo } : {}
      const data = await listClips(params)
      setClips(data.clips || [])
    } catch (error) {
      setNotice({ type: 'error', text: describeError(error) })
    } finally {
      setClipsLoading(false)
    }
  }, [])

  // Refresh the gallery + cached transcript whenever the chosen video changes.
  useEffect(() => {
    let cancelled = false

    if (!videoId) {
      setVideo(null)
      setTranscript(null)
      loadClips(null)
      return () => {
        cancelled = true
      }
    }

    ;(async () => {
      await loadClips(videoId)
      try {
        const data = await getVideo(videoId)
        if (!cancelled) setVideo(data.video)
      } catch {
        if (!cancelled) setVideo(null)
      }
      try {
        const data = await getTranscript(videoId)
        if (!cancelled) setTranscript(data.transcript)
      } catch {
        if (!cancelled) setTranscript(null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [videoId, loadClips])

  useEffect(() => {
    loadHealth()
    loadClips(null)
    loadConfig()
  }, [loadHealth, loadClips, loadConfig])

  // -- job orchestration ----------------------------------------------------
  const handleSettled = useCallback(
    (job) => {
      if (job.status === 'succeeded') {
        const result = job.result || {}
        if (job.type === 'download' && result.video) setVideo(result.video)
        if (job.type === 'transcribe' && result.transcript) {
          setTranscript(result.transcript)
        }
        if (job.type === 'clips') {
          setNotice({
            type: 'success',
            text: `Generated ${result.clip_count || 0} vertical ${
              result.clip_count === 1 ? 'clip' : 'clips'
            } from "${result.title || 'the video'}".`,
          })
          loadClips(job.params?.video_id || videoId)
        }
      } else if (job.status === 'failed') {
        setNotice({ type: 'error', text: job.error || 'The job failed.' })
      }
    },
    [loadClips, videoId],
  )

  const downloadJob = useJob(handleSettled)
  const transcribeJob = useJob(handleSettled)
  const clipsJob = useJob(handleSettled)

  const activeJob = clipsJob.isRunning
    ? { ...clipsJob.job, type: 'clips' }
    : transcribeJob.isRunning
      ? { ...transcribeJob.job, type: 'transcribe' }
      : downloadJob.isRunning
        ? { ...downloadJob.job, type: 'download' }
        : [clipsJob, transcribeJob, downloadJob]
            .map((entry) => entry.job)
            .filter((job) => job && job.status !== 'idle')
            .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]

  const anyRunning = clipsJob.isRunning || transcribeJob.isRunning || downloadJob.isRunning

  const cancelActive = () => {
    if (clipsJob.isRunning) return clipsJob.cancel()
    if (transcribeJob.isRunning) return transcribeJob.cancel()
    if (downloadJob.isRunning) return downloadJob.cancel()
  }

  const dismissActive = () => {
    clipsJob.reset()
    transcribeJob.reset()
    downloadJob.reset()
  }

  // -- actions --------------------------------------------------------------
  const runDownload = async () => {
    if (!videoId) return
    setNotice(null)
    try {
      const started = await startDownload({ url, video_id: videoId })
      downloadJob.track(started, 'download')
    } catch (error) {
      setNotice({ type: 'error', text: describeError(error) })
    }
  }

  const runTranscribe = async () => {
    if (!videoId) return
    setNotice(null)
    try {
      const started = await startTranscribe({
        video_id: videoId,
        url,
        model: options.model,
        force: false,
      })
      transcribeJob.track(started, 'transcribe')
    } catch (error) {
      setNotice({ type: 'error', text: describeError(error) })
    }
  }

  const runGenerate = async () => {
    if (!videoId) return
    setNotice(null)
    try {
      const started = await startClips({
        video_id: videoId,
        url,
        count: options.count,
        min_seconds: options.minSeconds,
        max_seconds: options.maxSeconds,
        target_seconds: options.targetSeconds,
        keywords: options.keywords,
        vertical_mode: options.verticalMode,
        captions: options.captions,
        auto_transcribe: options.autoTranscribe,
        model: options.model,
      })
      clipsJob.track(started, 'clips')
    } catch (error) {
      setNotice({ type: 'error', text: describeError(error) })
    }
  }

  const removeClip = async (clipId) => {
    try {
      await deleteClip(clipId)
      setClips((current) => current.filter((clip) => clip.id !== clipId))
      setNotice({ type: 'success', text: 'Clip deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: describeError(error) })
    }
  }

  const removeVideo = async () => {
    if (!videoId) return
    try {
      await deleteVideo(videoId)
      setVideo(null)
      setTranscript(null)
      setClips([])
      setUrl('')
      setNotice({ type: 'success', text: 'Video and all its clips deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: describeError(error) })
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="logo">▶</span>
          <div>
            <h1>Coppify</h1>
            <p>YouTube link &rarr; 9:16 short clips, built with open source</p>
          </div>
        </div>
        <HealthBar health={health} error={healthError} onRetry={loadHealth} />
      </header>

      <main className="main">
        <div className="columns">
          <div className="column column--controls">
            <UrlForm
              url={url}
              onUrlChange={setUrl}
              busy={anyRunning}
              onDownload={runDownload}
              onTranscribe={runTranscribe}
              onGenerate={runGenerate}
            />

            {video && (
              <section className="card video-card">
                {video.thumbnail && (
                  <img className="video-card__thumb" src={video.thumbnail} alt="" />
                )}
                <div>
                  <h2 className="video-card__title">{video.title}</h2>
                  <p className="hint">
                    {video.uploader ? `${video.uploader} · ` : ''}
                    {video.width > 0 ? `${video.width}x${video.height} · ` : ''}
                    downloaded
                    {video.reused ? ' (cached)' : ''}
                  </p>
                  <div className="chips">
                    {video.has_transcript && (
                      <span className="chip chip--ok">transcript cached</span>
                    )}
                    <a
                      className="link-btn"
                      href={video.webpage_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open on YouTube
                    </a>
                    <button
                      className="link-btn link-btn--danger"
                      type="button"
                      onClick={removeVideo}
                    >
                      delete video
                    </button>
                  </div>
                </div>
              </section>
            )}

            <OptionsPanel
              options={options}
              onChange={setOptions}
              disabled={anyRunning}
              whisperModels={health?.whisper_models || []}
            />

            <ProgressPanel
              job={activeJob}
              isRunning={anyRunning}
              onCancel={cancelActive}
              onDismiss={dismissActive}
            />

            {notice && (
              <div className={`alert alert--${notice.type}`}>
                {notice.text}
                <button className="link-btn" type="button" onClick={() => setNotice(null)}>
                  dismiss
                </button>
              </div>
            )}
          </div>

          <div className="column column--output">
            <ClipGallery
              clips={clips}
              loading={clipsLoading}
              onDelete={removeClip}
              onRefresh={() => loadClips(videoId || null)}
              title={videoId ? `Clips from this video (${clips.length})` : `All clips (${clips.length})`}
            />

            <TranscriptPanel transcript={transcript} videoId={videoId} />
          </div>
        </div>
      </main>

      <footer className="footer">
        <span>
          yt-dlp &rarr; Whisper &rarr; FFmpeg. Everything runs locally.
        </span>
        <span className="footer__api">
          API: <code>{API_BASE}</code>
        </span>
      </footer>
    </div>
  )
}