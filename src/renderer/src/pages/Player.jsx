import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { renderClickTrack } from '../audio/click.js'
import { createEngine } from '../audio/engine.js'
import { METERS, barStarts, beatGrid, clickEvents } from '../audio/grid.js'
import { effectiveGains, muteToggled, showsMuted, soloToggled } from '../audio/mixer.js'
import { ACTIVE_STATUSES, STAGE_LABELS, formatGain, formatTime } from '../format.js'
import { GridLines, RulerBars } from '../components/BeatGrid.jsx'
import CancelButton from '../components/CancelButton.jsx'
import Waveform from '../components/Waveform.jsx'
import './Player.css'

// Track order in the DAW view, top to bottom.
// The metronome isn't a track: its click track is rendered from the beat grid and
// controlled from the transport, outside mute/solo.
const TRACKS = [
  { id: 'reference', name: 'Reference' },
  { id: 'drums', name: 'Drums' },
  { id: 'bass', name: 'Bass' },
  { id: 'guitar', name: 'Guitar' },
  { id: 'piano', name: 'Piano' },
  { id: 'vocals', name: 'Vocals' },
  { id: 'other', name: 'Other' },
  { id: 'my_instrument', name: 'My instrument' },
]

// Reference (the full mix) starts muted so you hear the stems; everything else plays
const initialMixer = () =>
  Object.fromEntries(TRACKS.map((t) => [t.id, { muted: t.id === 'reference', soloed: false, gain: 1 }]))

// Shown under the transport while the session is still processing or audio is loading
function statusMessage(session, audioState) {
  if (!session) return null
  if (session.status === 'failed') return `Processing failed: ${session.error}`
  if (session.status === 'cancelled') {
    return session.files.reference ? 'Stem splitting was cancelled; the reference still plays.' : 'Processing was cancelled.'
  }
  if (audioState === 'loading') return 'Loading audio…'
  if (!session.files.reference) return STAGE_LABELS[session.status] ?? session.status
  if (session.status !== 'ready') {
    const percent = session.status === 'separating' && session.progress != null ? ` ${session.progress}%` : ''
    return `${STAGE_LABELS[session.status] ?? session.status}${percent} (stems will appear when done)`
  }
  return null
}

function Player() {
  const { sessionId } = useParams()
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)

  // Load the session, then follow processing updates (analysis, reference.wav, stems)
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    window.resonant.getSession(sessionId).then(
      (loaded) => !cancelled && setSession(loaded),
      (err) => !cancelled && setError(err.message),
    )
    const unsubscribe = window.resonant.onSessionUpdated((updated) => {
      if (updated.id === sessionId) setSession(updated)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  // Audio: one engine per session, created once reference.wav exists
  const engineRef = useRef(null)
  // Which audio source finished loading (or failed); 'loading' is derived from it
  const [loadResult, setLoadResult] = useState({ key: null, state: null })
  const [isPlaying, setIsPlaying] = useState(false)
  const [position, setPosition] = useState(0) // seconds
  const [duration, setDuration] = useState(0) // seconds
  const referenceFile = session?.files?.reference
  const audioKey = sessionId && referenceFile ? `${sessionId}/${referenceFile}` : null
  const audioState = !audioKey ? 'idle' : loadResult.key === audioKey ? loadResult.state : 'loading'

  useEffect(() => {
    if (!audioKey) return
    const engine = createEngine()
    engineRef.current = engine
    let cancelled = false
    engine.load('reference', `resonant://session/${audioKey}`).then(
      () => {
        if (cancelled) return
        setDuration(engine.duration)
        setLoadResult({ key: audioKey, state: 'ready' })
      },
      (err) => {
        if (cancelled) return
        setLoadResult({ key: audioKey, state: 'error' })
        setError(err.message)
      },
    )
    return () => {
      cancelled = true
      engineRef.current = null
      engine.close()
      setIsPlaying(false)
      setPosition(0)
    }
  }, [audioKey])

  // Stems join the same engine once separation has written them (immediately for a
  // finished session). load() ignores tracks it already has, so re-running is cheap.
  const stemFiles = session?.files?.stems
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !stemFiles) return
    for (const [id, path] of Object.entries(stemFiles)) {
      engine.load(id, `resonant://session/${sessionId}/${path}`).catch((err) => setError(err.message))
    }
  }, [sessionId, audioKey, stemFiles])

  // Waveform peaks, fetched once each as processing makes them available.
  // Keyed by URL, so another session's peaks never show up here.
  const peakFiles = session?.files?.peaks
  const [peaks, setPeaks] = useState({})
  const requestedPeaks = useRef(new Set())

  useEffect(() => {
    if (!sessionId || !peakFiles) return
    for (const path of Object.values(peakFiles)) {
      const url = `resonant://session/${sessionId}/${path}`
      if (requestedPeaks.current.has(url)) continue
      requestedPeaks.current.add(url)
      fetch(url)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.status))))
        .then((data) => setPeaks((prev) => ({ ...prev, [url]: data })))
        // Let a later session update retry it
        .catch(() => requestedPeaks.current.delete(url))
    }
  }, [sessionId, peakFiles])

  const peaksFor = (trackId) =>
    peakFiles?.[trackId] ? peaks[`resonant://session/${sessionId}/${peakFiles[trackId]}`] : undefined

  // Per-track mixer settings, applied to the engine as gains
  const [mixer, setMixer] = useState(initialMixer)

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    for (const [id, gain] of Object.entries(effectiveGains(mixer))) engine.setGain(id, gain)
  }, [mixer, audioState])

  // Move the playhead every frame while playing; stop and rewind at the end
  useEffect(() => {
    if (!isPlaying) return
    let frame
    const tick = () => {
      const engine = engineRef.current
      if (!engine) return
      const now = engine.position()
      if (now >= engine.duration) {
        engine.pause()
        engine.seek(0)
        setIsPlaying(false)
        setPosition(0)
        return
      }
      setPosition(now)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [isPlaying])

  function togglePlay() {
    const engine = engineRef.current
    if (!engine) return
    if (engine.playing) {
      engine.pause()
      setPosition(engine.position())
      setIsPlaying(false)
    } else {
      engine.play()
      setIsPlaying(true)
    }
  }

  function updateTrack(id, changes) {
    setMixer((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }))
  }

  // Metronome click: separate from the tracks, so soloing a track never silences it.
  const [metronome, setMetronome] = useState({ enabled: true, gain: 1, subdivision: 'off' })
  const timeSignature = session?.timeSignature ?? '4/4'
  const { beatsPerBar } = METERS[timeSignature] ?? METERS['4/4']
  // Moves where bars start, for songs whose first grid beat isn't beat 1. Saved
  // with the session. Wrapped to the bar length in case the time signature changed.
  const barShift = (session?.barShift ?? 0) % beatsPerBar

  // Beat grid from the analysis. Session updates arrive as new objects, but a
  // session's beats never change once set, so key on the session and beat count.
  const beats = session?.analysis?.beats
  const beatsKey = beats ? `${sessionId}:${beats.length}` : null
  const grid = useMemo(
    () => (beats && duration > 0 ? beatGrid(beats, duration) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see beatsKey
    [beatsKey, duration],
  )
  const bars = useMemo(
    () => (grid ? barStarts(grid.beats, { timeSignature, barShift }) : []),
    [grid, timeSignature, barShift],
  )

  // Render the click track whenever the grid or click settings change, and swap it in
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !grid) return
    let cancelled = false
    const events = clickEvents(grid.beats, {
      timeSignature,
      subdivision: metronome.subdivision,
      barShift,
    })
    renderClickTrack(events, duration).then(
      (buffer) => !cancelled && engine.setBuffer('metronome', buffer),
      (err) => !cancelled && setError(err.message),
    )
    return () => {
      cancelled = true
    }
  }, [grid, duration, timeSignature, metronome.subdivision, barShift])

  useEffect(() => {
    engineRef.current?.setGain('metronome', metronome.enabled ? metronome.gain : 0)
  }, [metronome.enabled, metronome.gain, audioState])

  // Updates the page straight away, then saves; the saved session comes back
  // through onSessionUpdated.
  const shiftBar = (delta) => {
    const next = (((barShift + delta) % beatsPerBar) + beatsPerBar) % beatsPerBar
    setSession((s) => ({ ...s, barShift: next }))
    window.resonant.updateSessionDetails(sessionId, { barShift: next }).catch((err) => setError(err.message))
  }

  // Playhead as a fraction of the song (0 = start, 1 = end)
  const playhead = duration > 0 ? position / duration : 0

  function seekFromPointer(event) {
    const engine = engineRef.current
    if (!engine || duration === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    engine.seek(fraction * duration)
    setPosition(engine.position())
  }

  function handleRulerPointerDown(event) {
    event.currentTarget.setPointerCapture(event.pointerId)
    seekFromPointer(event)
  }

  function handleRulerPointerMove(event) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event)
  }

  const gains = effectiveGains(mixer)
  const analysis = session?.analysis
  const title = session ? (session.songName ?? session.source.fileName) : 'No session loaded'
  const status = statusMessage(session, audioState)

  return (
    <main className="player">
      <header className="player__header">
        <Link to="/" className="back-link">
          ← Sessions
        </Link>
        <div className="player__heading">
          <h1 className="player__title">{title}</h1>
          {session?.artist && <span className="player__artist">{session.artist}</span>}
        </div>
        <dl className="player__info">
          <div>
            <dt>Key</dt>
            <dd>{analysis ? `${analysis.key} ${analysis.scale}` : '—'}</dd>
          </div>
          <div>
            <dt>BPM</dt>
            <dd>{analysis ? Math.round(analysis.bpm) : '—'}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{session?.timeSignature ?? '4/4'}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{analysis ? formatTime(analysis.durationSec) : '—'}</dd>
          </div>
        </dl>
      </header>

      <div className="transport">
        <button
          type="button"
          className="transport__play"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          disabled={audioState !== 'ready'}
          onClick={togglePlay}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d={isPlaying ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z'} fill="currentColor" />
          </svg>
        </button>
        <span className="transport__time">
          {formatTime(position)} / {formatTime(duration)}
        </span>
        <div className="transport__metronome">
          <button
            type="button"
            className="transport__toggle"
            aria-pressed={metronome.enabled}
            onClick={() => setMetronome((m) => ({ ...m, enabled: !m.enabled }))}
          >
            Metronome
          </button>
          <div className="gain">
            <input
              type="range"
              className="transport__gain"
              min="0"
              max="2"
              step="0.01"
              value={metronome.gain}
              aria-label="Metronome volume"
              aria-valuetext={formatGain(metronome.gain)}
              onChange={(e) => setMetronome((m) => ({ ...m, gain: Number(e.target.value) }))}
              onDoubleClick={() => setMetronome((m) => ({ ...m, gain: 1 }))}
            />
            <output className="gain__value">{formatGain(metronome.gain)}</output>
          </div>
          <div className="segmented segmented--small" role="radiogroup" aria-label="Click subdivision">
            {[
              ['off', 'Beats'],
              ['eighth', '8ths'],
              ['sixteenth', '16ths'],
            ].map(([value, label]) => (
              <label key={value} className="segmented__option">
                <input
                  type="radio"
                  name="subdivision"
                  value={value}
                  checked={metronome.subdivision === value}
                  onChange={() => setMetronome((m) => ({ ...m, subdivision: value }))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="bar-shift" title="Move where bars start (the accent click, bar lines and numbers) if bar 1 isn't on the first beat">
            <span>Bar start</span>
            <button type="button" className="track__toggle" aria-label="Bar start one beat earlier" onClick={() => shiftBar(-1)}>
              ‹
            </button>
            <button type="button" className="track__toggle" aria-label="Bar start one beat later" onClick={() => shiftBar(1)}>
              ›
            </button>
          </div>
        </div>
      </div>

      {!sessionId && (
        <p className="player__status">
          Import a song on the <Link to="/convert" className="back-link">Convert</Link> page to open it here.
        </p>
      )}
      {status && (
        <div className="player__status-row">
          <p className="player__status" aria-live="polite">
            {status}
          </p>
          {ACTIVE_STATUSES.includes(session.status) && <CancelButton sessionId={session.id} />}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="timeline" aria-label="Tracks">
        <div className="timeline__content" style={{ '--playhead': playhead }}>
          <div
            className="timeline__ruler"
            onPointerDown={handleRulerPointerDown}
            onPointerMove={handleRulerPointerMove}
          >
            {grid && <RulerBars bars={bars} duration={duration} />}
            <div className="timeline__playhead-handle" />
          </div>
          {TRACKS.map((track) => (
            <div key={track.id} className="track" role="group" aria-label={track.name}>
              <div className="track__header">
                <span className="track__name">{track.name}</span>
                <div className="track__controls">
                  <button
                    type="button"
                    className="track__toggle track__toggle--mute"
                    aria-pressed={showsMuted(mixer[track.id])}
                    aria-label={`Mute ${track.name}`}
                    onClick={() => updateTrack(track.id, muteToggled(mixer[track.id]))}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className="track__toggle track__toggle--solo"
                    aria-pressed={mixer[track.id].soloed}
                    aria-label={`Solo ${track.name}`}
                    onClick={() => updateTrack(track.id, soloToggled(mixer[track.id]))}
                  >
                    S
                  </button>
                </div>
                <div className="gain">
                  <input
                    type="range"
                    className="track__gain"
                    min="0"
                    max="1.5"
                    step="0.01"
                    value={mixer[track.id].gain}
                    aria-label={`${track.name} gain`}
                    aria-valuetext={formatGain(mixer[track.id].gain)}
                    onChange={(e) => updateTrack(track.id, { gain: Number(e.target.value) })}
                    onDoubleClick={() => updateTrack(track.id, { gain: 1 })}
                  />
                  <output className="gain__value">{formatGain(mixer[track.id].gain)}</output>
                </div>
              </div>
              <div className={`track__lane${gains[track.id] === 0 ? ' track__lane--silent' : ''}`}>
                {peaksFor(track.id) && <Waveform peaks={peaksFor(track.id)} />}
              </div>
            </div>
          ))}
          {grid && (
            <div className="timeline__grid">
              <GridLines beats={grid.beats} bars={bars} duration={duration} />
            </div>
          )}
          <div className="timeline__playhead" />
        </div>
      </section>
    </main>
  )
}

export default Player
