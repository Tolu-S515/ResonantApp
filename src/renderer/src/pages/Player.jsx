import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { BACKING_MAX_DB, BACKING_MIN_DB, backingGain, loadBackingDb, saveBackingDb } from '../audio/backing.js'
import { renderClickTrack } from '../audio/click.js'
import { createEngine } from '../audio/engine.js'
import { METERS, barStarts, beatGrid, clickEvents } from '../audio/grid.js'
import { effectiveGains, muteToggled, showsMuted, soloToggled } from '../audio/mixer.js'
import { MAX_TRACKS } from '../../../shared/audio-settings.js'
import { findOutputDevice } from '../audio/output.js'
import { formatSemitones, formatSpeed, transposeKey } from '../audio/transpose.js'
import { MAX_TRANSPOSE, SPEEDS } from '../../../shared/session.js'
import { freeInput, inputOptions, trackPeaks } from '../audio/instruments.js'
import { useAudioMeters, useAudioState } from '../audio/useAudioState.js'
import { useInstruments } from '../audio/useInstruments.js'
import { ACTIVE_STATUSES, STAGE_LABELS, formatGain, formatTime } from '../format.js'
import { GridLines, RulerBars } from '../components/BeatGrid.jsx'
import CancelButton from '../components/CancelButton.jsx'
import ChordDisplay from '../components/ChordDisplay.jsx'
import Dropdown from '../components/Dropdown.jsx'
import InstrumentTrack from '../components/InstrumentTrack.jsx'
import SettingsMenu from '../components/SettingsMenu.jsx'
import Waveform from '../components/Waveform.jsx'
import './Player.css'

// Backing-track order in the DAW view, top to bottom. Instrument tracks (live
// input through the native engine) follow them.
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
  // Recording runs with playback, on the record-enabled instrument tracks
  const [isRecording, setIsRecording] = useState(false)
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

  // Songs imported before chord detection existed: find their chords from the stems
  // (once per visit; the result arrives through onSessionUpdated)
  const needsChords = session?.status === 'ready' && !!session.files?.stems && session.chords == null
  useEffect(() => {
    if (!sessionId || !needsChords) return
    window.resonant.detectChords(sessionId).catch((err) => console.warn('Chord detection:', err.message))
  }, [sessionId, needsChords])

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

  // Backing tracks play out of the chosen audio interface, the same one the
  // instrument is monitored on, so both run off one clock. Falls back to the
  // system output when it isn't connected. Rechecked when devices change.
  const nativeAudio = useAudioState()
  const interfaceName = nativeAudio?.settings.name ?? null
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    let cancelled = false
    const route = () =>
      findOutputDevice(interfaceName)
        .then((deviceId) => !cancelled && engine.setOutputDevice(deviceId ?? ''))
        .catch((err) => !cancelled && setError(`Could not switch audio output: ${err.message}`))
    route()
    navigator.mediaDevices.addEventListener('devicechange', route)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', route)
    }
  }, [audioKey, interfaceName])

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
        setIsRecording(false)
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
      setIsRecording(false)
    } else {
      engine.play()
      setIsPlaying(true)
    }
  }

  // Record: starts playback and records from the playhead. Pressing it again stops both.
  // (Capturing audio comes with the engine side of recording.)
  function toggleRecord() {
    const engine = engineRef.current
    if (!engine) return
    if (isRecording) {
      if (engine.playing) togglePlay()
      setIsRecording(false)
      return
    }
    setIsRecording(true)
    if (!engine.playing) {
      engine.play()
      setIsPlaying(true)
    }
  }

  function updateTrack(id, changes) {
    setMixer((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }))
  }

  // Backing level: the whole song and click together, so the live instrument
  // (mixed in by macOS alongside it) can sit on top. Remembered between sessions.
  const [backingDb, setBackingDb] = useState(loadBackingDb)
  useEffect(() => {
    engineRef.current?.setBackingLevel(backingGain(backingDb))
    saveBackingDb(backingDb)
  }, [backingDb, audioState])

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

  // What the engine is actually playing: the speed (set in real time, a moment after
  // it's chosen) and the key (a render, swapped in when ready). A new engine starts
  // at normal speed on the original stems.
  const [applied, setApplied] = useState({ audioKey: null, speed: 1, transpose: 0 })
  const playingSpeed = applied.audioKey === audioKey ? applied.speed : 1
  const playingTranspose = applied.audioKey === audioKey ? applied.transpose : 0
  const markApplied = (changes) =>
    setApplied((prev) => ({
      ...(prev.audioKey === audioKey ? prev : { speed: 1, transpose: 0 }),
      audioKey,
      ...changes,
    }))

  // Render the click track whenever the grid, click settings or playing speed change,
  // and swap it in. Built at the new tempo (beat times / speed) rather than stretched
  // or pitch-corrected, so it stays sharp.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !grid) return
    let cancelled = false
    const events = clickEvents(grid.beats, {
      timeSignature,
      subdivision: metronome.subdivision,
      barShift,
    }).map((event) => ({ ...event, time: event.time / playingSpeed }))
    renderClickTrack(events, duration / playingSpeed).then(
      (buffer) => !cancelled && engine.setBuffer('metronome', buffer),
      (err) => !cancelled && setError(err.message),
    )
    return () => {
      cancelled = true
    }
  }, [grid, duration, timeSignature, metronome.subdivision, barShift, playingSpeed])

  useEffect(() => {
    engineRef.current?.setGain('metronome', metronome.enabled ? metronome.gain : 0)
  }, [metronome.enabled, metronome.gain, audioState])

  // Updates the page straight away, then saves; the saved session comes back
  // through onSessionUpdated.
  const saveDetails = (changes) => {
    if (!sessionId) return
    setSession((s) => ({ ...s, ...changes }))
    window.resonant.updateSessionDetails(sessionId, changes).catch((err) => setError(err.message))
  }
  const shiftBar = (delta) => saveDetails({ barShift: (((barShift + delta) % beatsPerBar) + beatsPerBar) % beatsPerBar })

  // Practice speed and key change, saved with the session.
  // (The UI for now: playback at the new speed/key comes with the Rubber Band renders.)
  const speed = session?.speed ?? 1
  const transpose = session?.transpose ?? 0
  const speedOptions = SPEEDS.map((s) => ({ value: String(s), label: formatSpeed(s) }))
  // Speed: applied in real time as soon as it's chosen (and saved with the session)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || audioState !== 'ready' || playingSpeed === speed) return
    let cancelled = false
    engine.setSpeed(speed).then(
      (done) => done && !cancelled && markApplied({ speed }),
      (err) => !cancelled && setError(`Could not change speed: ${err.message}`),
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markApplied only closes over audioKey
  }, [audioKey, audioState, speed, playingSpeed])

  // Key change being set up in the transport. Nothing renders until Render is pressed,
  // which saves it to the session (the render below follows the saved value).
  const [draft, setDraft] = useState(null) // { sessionId, transpose }
  const draftTranspose = draft?.sessionId === sessionId ? draft.transpose : transpose
  const setTranspose = (next) =>
    setDraft({ sessionId, transpose: Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, next)) })
  const draftChanged = draftTranspose !== transpose
  const applyDraft = () => {
    saveDetails({ transpose: draftTranspose })
    setDraft(null)
  }
  // Key renders need the finished stems (or just the reference, if splitting stopped)
  const canChangeKey =
    Boolean(session?.files?.reference) && ['ready', 'cancelled', 'failed'].includes(session?.status)

  // Gets the chosen key rendered (or the cached render), then swaps it in. The
  // current version keeps playing meanwhile. Changing again cancels the render.
  const [rendering, setRendering] = useState(null) // { done, total } while preparing
  const needsSwap = playingTranspose !== transpose
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || audioState !== 'ready' || !canChangeKey || !needsSwap) return
    let cancelled = false
    setRendering({ done: 0, total: 0 })
    const unsubscribe = window.resonant.onRenderProgress((progress) => {
      if (!cancelled && progress.sessionId === sessionId) setRendering({ done: progress.done, total: progress.total })
    })
    window.resonant
      .prepareRender(sessionId, transpose)
      .then(async (result) => {
        if (cancelled || result.cancelled) return
        const decoded = await Promise.all(
          Object.entries(result.files).map(async ([id, path]) => [
            id,
            await engine.decode(`resonant://session/${sessionId}/${path}`, id),
          ]),
        )
        if (cancelled) return
        engine.swapBuffers(new Map(decoded))
        markApplied({ transpose })
        setRendering(null)
      })
      .catch((err) => {
        if (cancelled) return
        setRendering(null)
        setError(`Could not change key: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markApplied only closes over audioKey
  }, [audioKey, audioState, canChangeKey, needsSwap, sessionId, transpose])
  const renderingShown = needsSwap && rendering

  // Moves the playhead (keeps playing if it was)
  function seekTo(time) {
    const engine = engineRef.current
    if (!engine || audioState !== 'ready') return
    engine.seek(time)
    setPosition(engine.position())
  }

  // Keyboard: Space plays/pauses, ← (or Home) goes back to the start.
  // Left alone while typing, on sliders and dropdowns (they use the arrows), and
  // Space is left to a focused button (it presses it).
  const keysRef = useRef(null)
  keysRef.current = { togglePlay, seekTo }
  useEffect(() => {
    function onKeyDown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target
      if (target.closest?.('input, textarea, select, [contenteditable="true"], [aria-haspopup], [role="listbox"]')) return
      const keys = keysRef.current
      if (event.key === ' ' && !target.closest?.('button, a')) keys.togglePlay()
      else if (event.key === 'ArrowLeft' || event.key === 'Home') keys.seekTo(0)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

  // Instrument tracks: live input through the native engine
  const {
    instruments,
    update: updateInstrument,
    setInputs: setInstrumentInputs,
    add: addInstrument,
    remove: removeInstrument,
  } = useInstruments()
  const meters = useAudioMeters()
  const engineInfo = nativeAudio?.info ?? null
  // Unknown while unplugged: offer at least what the tracks already use
  const channelCount =
    engineInfo?.inputChannels ?? Math.max(2, ...(instruments ?? []).flatMap((t) => t.inputs.map((c) => c + 1)))

  const anyArmed = instruments?.some((t) => t.armed) ?? false
  let recordHint = 'Record'
  if (!engineInfo) recordHint = 'Connect your audio interface to record'
  else if (speed !== 1 || playingSpeed !== 1) recordHint = 'Recording needs 100% speed (a key change is fine)'
  else if (!anyArmed) recordHint = 'Enable recording on an instrument track first (the dot by its name)'
  else if (isRecording) recordHint = 'Stop recording'

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
            <dd>
              {analysis ? `${transposeKey(analysis.key, transpose)} ${analysis.scale}` : '—'}
              {analysis && transpose !== 0 && (
                <span className="player__original">
                  {analysis.key} {formatSemitones(transpose)}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>BPM</dt>
            <dd>
              {analysis ? Math.round(analysis.bpm * speed) : '—'}
              {analysis && speed !== 1 && (
                <span className="player__original">
                  {Math.round(analysis.bpm)} at {formatSpeed(speed)}
                </span>
              )}
            </dd>
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
        <SettingsMenu />
      </header>

      <div className="transport">
        <div className="transport__buttons">
          <button
            type="button"
            className="transport__step"
            aria-label="Back to start"
            title="Back to start (←)"
            disabled={audioState !== 'ready'}
            onClick={() => seekTo(0)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 5h2v14H6zM19 5v14L9 12z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="transport__play"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            disabled={audioState !== 'ready'}
            onClick={togglePlay}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d={isPlaying ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z'} fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="transport__record"
            aria-label={isRecording ? 'Stop recording' : 'Record'}
            aria-pressed={isRecording}
            title={recordHint}
            disabled={
              audioState !== 'ready' ||
              !engineInfo ||
              ((!anyArmed || speed !== 1 || playingSpeed !== 1) && !isRecording)
            }
            onClick={toggleRecord}
          >
            <span className="record-dot" aria-hidden="true" />
          </button>
        </div>
        <span className="transport__time">
          {formatTime(position)} / {formatTime(duration)}
        </span>
        <div className="transport__practice">
          <div className="transport__field" title="Practice speed, applied straight away. The pitch stays the same.">
            <span className="transport__label">Speed</span>
            <Dropdown
              className="transport__dropdown"
              label="Speed"
              value={String(speed)}
              options={speedOptions}
              disabled={!sessionId}
              onChange={(value) => saveDetails({ speed: Number(value) })}
            />
          </div>
          <div className="transport__field" title="Key change, in semitones. The speed stays the same.">
            <span className="transport__label">Key</span>
            <div className="stepper">
              <button
                type="button"
                className="track__toggle"
                aria-label="Key down a semitone"
                disabled={!canChangeKey || draftTranspose <= -MAX_TRANSPOSE}
                onClick={() => setTranspose(draftTranspose - 1)}
              >
                −
              </button>
              <button
                type="button"
                className="stepper__value"
                aria-label={`Key change ${formatSemitones(draftTranspose)} semitones. Click to reset.`}
                title="Click to reset"
                disabled={!canChangeKey || draftTranspose === 0}
                onClick={() => setTranspose(0)}
              >
                {formatSemitones(draftTranspose)}
              </button>
              <button
                type="button"
                className="track__toggle"
                aria-label="Key up a semitone"
                disabled={!canChangeKey || draftTranspose >= MAX_TRANSPOSE}
                onClick={() => setTranspose(draftTranspose + 1)}
              >
                +
              </button>
            </div>
            {analysis && (
              <span className="transport__key-name" aria-live="polite">
                {transposeKey(analysis.key, draftTranspose)} {analysis.scale}
              </span>
            )}
          </div>
          {draftChanged && (
            <button
              type="button"
              className="transport__render"
              title="Render the song in this key. The current version keeps playing meanwhile."
              onClick={applyDraft}
            >
              {draftTranspose === 0 ? 'Back to original' : 'Render'}
            </button>
          )}
          {renderingShown && (
            <span className="transport__rendering" role="status">
              <span className="transport__spinner" aria-hidden="true" />
              {rendering.total ? `Preparing ${rendering.done}/${rendering.total}` : 'Preparing…'}
            </span>
          )}
        </div>
        <div className="transport__backing" title="Turns the whole song and click down together, to leave room for your instrument. Double-click for 0 dB.">
          <span className="transport__label">Song</span>
          <div className="gain">
            <input
              type="range"
              className="transport__gain"
              min={BACKING_MIN_DB}
              max={BACKING_MAX_DB}
              step="0.5"
              value={backingDb}
              aria-label="Song volume"
              aria-valuetext={formatGain(backingGain(backingDb))}
              onChange={(e) => setBackingDb(Number(e.target.value))}
              onDoubleClick={() => setBackingDb(0)}
            />
            <output className="gain__value">{formatGain(backingGain(backingDb))}</output>
          </div>
        </div>
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

      {session && (
        <ChordDisplay
          chords={session.chords}
          position={position}
          transpose={playingTranspose}
          songKey={session.analysis?.key}
          scale={session.analysis?.scale}
        />
      )}

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
          {instruments?.map((track, index) => (
            <InstrumentTrack
              key={index}
              name={`My Instrument ${index + 1}`}
              track={track}
              options={inputOptions(instruments, index, channelCount)}
              peaks={trackPeaks(meters.tracks, index)}
              connected={Boolean(engineInfo)}
              problem={nativeAudio?.error ?? null}
              onChange={(changes) => updateInstrument(index, changes)}
              onInputChange={(value) => setInstrumentInputs(index, value)}
              recording={isRecording}
              onRemove={index > 0 ? () => removeInstrument(index) : undefined}
            />
          ))}
          {instruments && (
            <button
              type="button"
              className="timeline__add-track"
              onClick={() => addInstrument(channelCount)}
              disabled={instruments.length >= MAX_TRACKS || freeInput(instruments, channelCount) === -1}
              title={
                freeInput(instruments, channelCount) === -1
                  ? 'Every input already has a track. Switch a track to a single input to add another.'
                  : undefined
              }
            >
              + Add instrument
            </button>
          )}
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
