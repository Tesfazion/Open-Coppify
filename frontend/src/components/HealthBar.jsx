/** Backend capability strip shown in the header. */
export default function HealthBar({ health, error, onRetry }) {
  if (error) {
    return (
      <div className="health health--bad">
        <strong>Backend unreachable.</strong> {error}{' '}
        <button className="link-btn" type="button" onClick={onRetry}>
          retry
        </button>
      </div>
    )
  }

  if (!health) {
    return <div className="health health--pending">Checking backend...</div>
  }

  const ffmpeg = health.ffmpeg?.ok
  const whisper = health.whisper?.ok
  const ytdlp = Boolean(health.ytdlp_version)
  const allGood = ffmpeg && whisper && ytdlp

  return (
    <div className={`health ${allGood ? 'health--ok' : 'health--warn'}`}>
      <span className={`dot ${ffmpeg ? 'dot--ok' : 'dot--bad'}`} title="FFmpeg binary" />
      <span>FFmpeg {ffmpeg ? 'ready' : 'missing'}</span>
      <span className="health__sep" />
      <span className={`dot ${whisper ? 'dot--ok' : 'dot--bad'}`} title="Whisper" />
      <span>
        Whisper {whisper ? health.whisper.backend : 'missing'}
        {whisper ? ` (${health.whisper.device})` : ''}
      </span>
      <span className="health__sep" />
      <span className={`dot ${ytdlp ? 'dot--ok' : 'dot--bad'}`} title="yt-dlp" />
      <span>yt-dlp {health.ytdlp_version || 'missing'}</span>
      <span className="health__sep" />
      <span className="pill pill--muted">
        {health.clips_on_disk} clip{health.clips_on_disk === 1 ? '' : 's'} on disk
      </span>
    </div>
  )
}