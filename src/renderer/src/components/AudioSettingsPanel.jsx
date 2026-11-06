import { useCallback, useEffect, useState } from 'react'
import { BUFFER_SIZES } from '../../../shared/audio-settings.js'
import { offsetKey } from '../../../shared/recording.js'
import { calibrateRecording } from '../audio/calibrate.js'
import { useAudioMeters, useAudioState, useDeviceChange } from '../audio/useAudioState.js'
import Meter from './Meter.jsx'
import './AudioSettingsPanel.css'

const ms = (frames, sampleRate) => `${((frames / sampleRate) * 1000).toFixed(1)} ms`
const sameInterface = (a, b) => a && b && a.inputUid === b.inputUid && a.outputUid === b.outputUid

// Reported round trip: input + output latency, plus the bridge on split interfaces
function roundTrip(info) {
  return info.inputLatencyFrames + info.outputLatencyFrames + info.bridgeFrames
}

// Audio settings: connection status, interface, buffer size and input meters
function AudioSettingsPanel() {
  const state = useAudioState()
  const { inputs } = useAudioMeters()
  const [interfaces, setInterfaces] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [calibrating, setCalibrating] = useState(false)
  const [cableInput, setCableInput] = useState(0)

  // Lists interfaces again, and connects if the chosen one has appeared
  const rescan = useCallback(() => {
    window.resonant.audio.listInterfaces().then(setInterfaces, (err) => setError(err.message))
    window.resonant.audio.connect()
  }, [])
  useEffect(rescan, [rescan])
  useDeviceChange(rescan)

  // Runs an engine action, showing its error (if any) instead of an unhandled rejection
  async function run(action) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null
  const { settings, info } = state
  const selected = interfaces?.find((i) => sameInterface(i, settings))
  const savedButMissing = settings.inputUid && interfaces && !selected
  const sampleRate = info?.sampleRate ?? selected?.sampleRate ?? 44100
  const shownError = error ?? state.error

  // Saved offset, if it was measured with this interface and buffer size
  const calibration = settings.recordOffset?.key === offsetKey(settings) ? settings.recordOffset : null

  async function calibrate() {
    setCalibrating(true)
    await run(() => calibrateRecording({ interfaceName: settings.name, inputChannel: cableInput }))
    setCalibrating(false)
  }

  function chooseInterface(inputUid) {
    const chosen = interfaces.find((i) => i.inputUid === inputUid)
    if (!chosen) return
    run(() =>
      window.resonant.audio.setDevice({ inputUid: chosen.inputUid, outputUid: chosen.outputUid, name: chosen.name }),
    )
  }

  return (
    <div className="audio-settings">
      <div className="audio-settings__header">
        <h2 className="audio-settings__title">Audio settings</h2>
        <span className={`audio-settings__status${info ? ' audio-settings__status--on' : ''}`}>
          <span className="audio-settings__dot" aria-hidden="true" />
          {info ? 'Connected' : 'Not connected'}
        </span>
      </div>
      {info && (
        <p className="audio-settings__info">
          {info.sampleRate / 1000} kHz · round trip about <strong>{ms(roundTrip(info), info.sampleRate)}</strong> (as
          reported by the interface)
        </p>
      )}
      {shownError && (
        <p className="error" role="alert">
          {shownError}
        </p>
      )}

      <section className="audio-settings__section">
        <div className="audio-settings__field">
          <div className="audio-settings__row audio-settings__row--spread">
            <span id="audio-interface-label" className="audio-settings__label">
              Audio interface
            </span>
            <button type="button" className="audio-settings__rescan" onClick={rescan} disabled={busy}>
              Rescan
            </button>
          </div>
          <div className="audio-settings__interfaces" role="radiogroup" aria-labelledby="audio-interface-label">
            {interfaces?.map((i) => {
              const isSelected = i === selected
              return (
                <button
                  key={i.inputUid}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`audio-settings__interface${isSelected ? ' audio-settings__interface--selected' : ''}`}
                  onClick={() => !isSelected && chooseInterface(i.inputUid)}
                  disabled={busy}
                >
                  <span className="audio-settings__radio" aria-hidden="true" />
                  <span className="audio-settings__interface-text">
                    <span className="audio-settings__interface-name">{i.name}</span>
                    <span className="audio-settings__interface-meta">
                      {i.inputChannels} in / {i.outputChannels} out · {i.sampleRate / 1000} kHz
                    </span>
                  </span>
                </button>
              )
            })}
            {savedButMissing && (
              <div className="audio-settings__interface audio-settings__interface--missing">
                <span className="audio-settings__radio" aria-hidden="true" />
                <span className="audio-settings__interface-text">
                  <span className="audio-settings__interface-name">{settings.name?.trim() || 'Saved interface'}</span>
                  <span className="audio-settings__interface-meta">Not connected</span>
                </span>
              </div>
            )}
            {interfaces?.length === 0 && !savedButMissing && (
              <p className="audio-settings__empty">No interface found. Plug one in and press Rescan.</p>
            )}
            {!interfaces && <p className="audio-settings__empty">Looking for interfaces…</p>}
          </div>
          <span className="audio-settings__hint">
            Your instrument is monitored through it, and backing tracks play through it too, so they stay in time.
          </span>
        </div>

        <div className="audio-settings__field">
          <span id="audio-buffer-label" className="audio-settings__label">
            Buffer size (samples)
          </span>
          <div className="audio-settings__buffers" role="radiogroup" aria-labelledby="audio-buffer-label">
            {BUFFER_SIZES.map((frames) => {
              const isSelected = frames === settings.bufferFrames
              return (
                <button
                  key={frames}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`audio-settings__buffer${isSelected ? ' audio-settings__buffer--selected' : ''}`}
                  onClick={() => !isSelected && run(() => window.resonant.audio.setDevice({ bufferFrames: frames }))}
                  disabled={busy}
                >
                  <span className="audio-settings__buffer-frames">{frames}</span>
                  <span className="audio-settings__buffer-ms">{ms(frames, sampleRate)}</span>
                </button>
              )
            })}
          </div>
          <span className="audio-settings__hint">Smaller sizes mean lower latency. If you hear clicks or dropouts, try a larger size.</span>
        </div>
      </section>

      {info && (
        <section className="audio-settings__section">
          <span className="audio-settings__label">Inputs</span>
          <ul className="audio-settings__meters">
            {Array.from({ length: info.inputChannels }, (_, c) => (
              <li key={c}>
                <span>Input {c + 1}</span>
                <Meter peak={inputs[c] ?? 0} label={`Input ${c + 1} level`} />
              </li>
            ))}
          </ul>
          <span className="audio-settings__hint">
            Play your instrument and set the interface&apos;s gain knob so the loudest parts stay out of the red.
          </span>
        </section>
      )}

      {info && (
        <section className="audio-settings__section">
          <div className="audio-settings__field">
            <span className="audio-settings__label">Recording sync</span>
            <p className="audio-settings__info">
              {calibration ? (
                <>
                  Calibrated: takes are moved <strong>{Math.abs(calibration.ms).toFixed(1)} ms</strong>{' '}
                  {calibration.ms >= 0 ? 'later' : 'earlier'} to line up with the song.
                </>
              ) : (
                'Not calibrated at this buffer size, so takes may land a few milliseconds off the beat.'
              )}
            </p>
            <span id="audio-cable-label" className="audio-settings__hint">
              Connect a cable from output 1 to an input, choose that input, then calibrate:
            </span>
            <div className="audio-settings__row">
              <div className="audio-settings__buffers" role="radiogroup" aria-labelledby="audio-cable-label">
                {Array.from({ length: info.inputChannels }, (_, c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={c === cableInput}
                    className={`audio-settings__buffer${c === cableInput ? ' audio-settings__buffer--selected' : ''}`}
                    onClick={() => setCableInput(c)}
                    disabled={busy}
                  >
                    <span className="audio-settings__buffer-frames audio-settings__nowrap">Input {c + 1}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="audio-settings__rescan" onClick={calibrate} disabled={busy}>
                {calibrating ? 'Listening…' : calibration ? 'Calibrate again' : 'Calibrate'}
              </button>
            </div>
            <span className="audio-settings__hint">
              It plays six loud clicks, so take your headphones off and pause the song first. Calibrate again after
              changing the buffer size.
            </span>
          </div>
        </section>
      )}
    </div>
  )
}

export default AudioSettingsPanel
