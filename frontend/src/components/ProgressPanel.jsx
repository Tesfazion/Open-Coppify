const LABELS = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export default function ProgressPanel({ job, isRunning, onCancel, onDismiss }) {
  if (!job || job.status === 'idle') return null

  const percent = Math.max(0, Math.min(100, Number(job.progress) || 0))
  const label = LABELS[job.status] || job.status
  const failed = job.status === 'failed'

  return (
    <section className={`card progress ${failed ? 'progress--failed' : ''}`}>
      <div className="progress__head">
        <div>
          <span className={`status status--${job.status}`}>{label}</span>
          <span className="progress__stage">{job.stage || 'Working'}</span>
        </div>
        <span className="progress__percent">{percent.toFixed(0)}%</span>
      </div>

      <div
        className="bar"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={job.stage || 'Progress'}
      >
        <div
          className={`bar__fill ${isRunning ? 'bar__fill--animated' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="progress__meta">
        <span>
          job <code>{job.id}</code>
          {job.type ? ` \u00b7 ${job.type}` : ''}
        </span>
        {job.elapsed != null && <span>{job.elapsed.toFixed(0)}s elapsed</span>}
      </div>

      {job.error && (
        <p className="alert alert--error">
          {job.error}
        </p>
      )}

      {Array.isArray(job.logs) && job.logs.length > 0 && (
        <details className="logs">
          <summary>Job log ({job.logs.length})</summary>
          <pre className="logs__body">
            {job.logs.map((line, index) => (
              <span key={index} className={`log log--${line.level}`}>
                {line.message}
              </span>
            ))}
          </pre>
        </details>
      )}

      <div className="progress__actions">
        {isRunning && (
          <button className="btn btn--ghost btn--small" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        {!isRunning && onDismiss && (
          <button className="btn btn--ghost btn--small" type="button" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </section>
  )
}