import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import logo from '../assets/resonant-logo.svg'
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
        <img src={logo} className="home__logo" alt="" />
        <h1>Resonant</h1>
        <Link to="/convert" className="button home__new">
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
                <SessionCard session={session} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

export default Home
