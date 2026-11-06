import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import logo from '../assets/resonant-logo.svg'
import logoDark from '../assets/resonant-logo-dark.svg'
import SettingsMenu from '../components/SettingsMenu.jsx'
import { ACTIVE_STATUSES, STAGE_LABELS, formatTime } from '../format.js'
import './Home.css'

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// "Splitting into stems… 42%", "Failed", or nothing once the stems are ready
function statusText({ status, progress }) {
  if (status === 'ready') return null
  if (status === 'failed') return 'Failed'
  if (status === 'separating' && progress != null) return `${STAGE_LABELS.separating} ${progress}%`
  return STAGE_LABELS[status] ?? status
}

function SessionCard({ session }) {
  const { analysis } = session
  const status = statusText(session)
  return (
    <Link to={`/player/${session.id}`} className="session-card">
      <div className="session-card__main">
        <span className="session-card__name">
          {session.songName ?? session.source.fileName}
          {session.artist && <span className="session-card__artist"> · {session.artist}</span>}
        </span>
        {analysis && (
          <span className="session-card__meta">
            {analysis.key} {analysis.scale} · {Math.round(analysis.bpm)} BPM · {formatTime(analysis.durationSec)}
          </span>
        )}
      </div>
      <div className="session-card__side">
        {status && (
          <span
            className={`session-card__status${ACTIVE_STATUSES.includes(session.status) ? ' session-card__status--active' : ''}`}
          >
            {status}
          </span>
        )}
        <span className="session-card__date">{formatDate(session.createdAt)}</span>
      </div>
    </Link>
  )
}

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

// A session in the list, with a trash button that asks before deleting.
// onDelete() resolves once the session is in the Trash (or rejects).
function SessionItem({ session, onDelete }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)
  const name = session.songName ?? session.source.fileName

  async function remove() {
    setDeleting(true)
    setError(null)
    try {
      await onDelete()
    } catch (err) {
      setDeleting(false)
      setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  if (confirming) {
    return (
      <div className="session-card session-card--confirm" role="alertdialog" aria-label={`Delete ${name}`}>
        <div className="session-card__main">
          <span className="session-card__name">Delete “{name}”?</span>
          <span className={error ? 'session-card__meta error' : 'session-card__meta'}>
            {error ??
              (ACTIVE_STATUSES.includes(session.status)
                ? 'Processing stops, and the song, stems and takes go to the Trash.'
                : 'The song, stems and takes go to the Trash.')}
          </span>
        </div>
        <div className="session-card__actions">
          <button type="button" className="button button--secondary" onClick={() => setConfirming(false)} disabled={deleting} autoFocus>
            Cancel
          </button>
          <button type="button" className="button button--danger" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`session-item${session.status === 'failed' ? ' session-item--failed' : ''}`}>
      <SessionCard session={session} />
      <button
        type="button"
        className="session-item__delete"
        aria-label={`Delete ${name}`}
        title="Delete session"
        onClick={() => setConfirming(true)}
      >
        <TrashIcon />
      </button>
    </div>
  )
}

function Home() {
  const [sessions, setSessions] = useState(null) // null while loading
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    window.resonant.listSessions().then(
      (list) => !cancelled && setSessions(list),
      (err) => !cancelled && setError(err.message),
    )
    // Sessions still processing in the background keep their progress up to date here
    const unsubscribe = window.resonant.onSessionUpdated((updated) => {
      setSessions((prev) => prev?.map((s) => (s.id === updated.id ? updated : s)) ?? prev)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return (
    <main className="app home">
      <header className="home__header">
        <h1 className="home__title">
          <picture>
            <source srcSet={logoDark} media="(prefers-color-scheme: dark)" />
            <img src={logo} className="home__logo" alt="Resonant" />
          </picture>
        </h1>
        <SettingsMenu className="home__settings" />
        <Link to="/convert" className="button">
          + New session
        </Link>
      </header>

      <section className="home__sessions" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading" className="home__heading">
          Sessions
        </h2>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {sessions?.length === 0 && (
          <p className="home__empty">No sessions yet. Start one with New session.</p>
        )}
        {sessions?.length > 0 && (
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <SessionItem
                  session={session}
                  onDelete={async () => {
                    await window.resonant.deleteSession(session.id)
                    setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? prev)
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

export default Home
