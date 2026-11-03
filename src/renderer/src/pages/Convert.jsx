import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import FileDropzone from '../components/FileDropzone.jsx'
import SessionDetailsForm from '../components/SessionDetailsForm.jsx'
import SessionStatus from '../components/SessionStatus.jsx'

// Typing pauses this long before the details are saved
const SAVE_DELAY_MS = 400

const fileNameWithoutExtension = (name) => name.replace(/\.[^.]+$/, '')

function Convert() {
  const navigate = useNavigate()
  const [file, setFile] = useState(null)
  const [session, setSession] = useState(null)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState(null)

  // Follow processing updates for the current session
  const sessionId = session?.id
  useEffect(() => {
    if (!sessionId) return
    return window.resonant.onSessionUpdated((updated) => {
      if (updated.id === sessionId) setSession(updated)
    })
  }, [sessionId])

  // Song details form. Kept in local state (not read back from session updates),
  // so a save landing mid-typing never overwrites what's in the inputs.
  const [details, setDetails] = useState(null)
  const detailsRef = useRef(null)
  const saveTimer = useRef(null)
  const lastSave = useRef(Promise.resolve())

  function saveNow(id) {
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    lastSave.current = window.resonant
      .updateSessionDetails(id, detailsRef.current)
      .catch((err) => setError(err.message))
    return lastSave.current
  }

  // Saves anything still waiting on the typing delay, then waits for it to land
  function flushDetails(id) {
    return saveTimer.current ? saveNow(id) : lastSave.current
  }

  function handleDetailsChange(values) {
    setDetails(values)
    detailsRef.current = values
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveNow(sessionId), SAVE_DELAY_MS)
  }

  // Leaving the page early: don't drop the last few keystrokes
  useEffect(() => {
    if (!sessionId) return
    return () => {
      if (saveTimer.current) saveNow(sessionId)
    }
  }, [sessionId])

  // Stems done: save the details, then open the session in the player
  const status = session?.status
  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    flushDetails(sessionId).then(() => {
      if (!cancelled) navigate(`/player/${sessionId}`)
    })
    return () => {
      cancelled = true
    }
  }, [status, sessionId, navigate])

  function handleFileSelected(selected) {
    setFile(selected)
    setSession(null)
    setDetails(null)
    setError(null)
  }

  async function handleStart() {
    setIsImporting(true)
    setError(null)
    try {
      const created = await window.resonant.importSong(file.path)
      const initial = { songName: '', artist: '', timeSignature: created.timeSignature }
      setDetails(initial)
      detailsRef.current = initial
      setSession(created)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsImporting(false)
    }
  }

  // While a song is processing, the form replaces the dropzone
  const isFinished = session && ['cancelled', 'failed'].includes(session.status)

  return (
    <main className="app">
      <h1>Convert</h1>
      <p>Choose a song to split it into stems.</p>
      <div className="page-center">
        <div className="convert-panel">
          {(!session || isFinished) && <FileDropzone file={file} onFileSelected={handleFileSelected} />}
          {/* Start again after a cancel or failure (makes a fresh session) */}
          {file && (!session || isFinished) && (
            <button type="button" className="button" onClick={handleStart} disabled={isImporting}>
              {isImporting ? 'Importing…' : 'Start'}
            </button>
          )}
          {session && details && !isFinished && (
            <SessionDetailsForm
              values={details}
              onChange={handleDetailsChange}
              namePlaceholder={fileNameWithoutExtension(session.source.fileName)}
            />
          )}
          {session && <SessionStatus session={session} />}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <nav className="convert-nav">
        <Link to="/" className="back-link">
          ← Back
        </Link>
        {/* Listen to the reference while the stems are still being made */}
        {session && !isFinished && (
          <Link to={`/player/${session.id}`} className="button button--secondary">
            Open player now
          </Link>
        )}
      </nav>
    </main>
  )
}

export default Convert
