import { ACTIVE_STATUSES, STAGE_LABELS, formatTime } from '../format.js'
import CancelButton from './CancelButton.jsx'

function Analysis({ analysis }) {
  const { key, scale, bpm, durationSec } = analysis
  return (
    <dl className="analysis">
      <div>
        <dt>Key</dt>
        <dd>
          {key} {scale}
        </dd>
      </div>
      <div>
        <dt>BPM</dt>
        <dd>{Math.round(bpm)}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{formatTime(durationSec)}</dd>
      </div>
    </dl>
  )
}

function SessionStatus({ session }) {
  const { status, progress, analysis, error } = session

  if (status === 'failed') {
    return (
      <p className="error" role="alert">
        Processing failed: {error}
      </p>
    )
  }

  const label = STAGE_LABELS[status] ?? status
  return (
    <>
      {analysis && <Analysis analysis={analysis} />}
      <div className="stage" aria-live="polite">
        <p className="status">
          {label}
          {status === 'separating' && progress != null && ` ${progress}%`}
        </p>
        {status === 'separating' && (
          <progress className="stage__bar" max="100" value={progress ?? 0} aria-label="Stem separation progress" />
        )}
        {ACTIVE_STATUSES.includes(status) && <CancelButton sessionId={session.id} />}
      </div>
    </>
  )
}

export default SessionStatus
