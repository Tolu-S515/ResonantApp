import { MAX_TRACK_GAIN_DB, MIN_TRACK_GAIN_DB, dbToGain, gainToDb } from '../../../shared/audio-settings.js'
import { formatGain } from '../format.js'
import { describeInputs, optionValue } from '../audio/instruments.js'
import { levelPeaks } from '../audio/peaks.js'
import { formatSemitones } from '../audio/transpose.js'
import Dropdown from './Dropdown.jsx'
import Meter from './Meter.jsx'
import Waveform from './Waveform.jsx'

// One "My Instrument" row: record arm, monitor toggle, which inputs it plays, its
// level and a live input meter. The lane shows the take it plays (where it sits in
// the song) with a picker for its other takes, or what the track is doing.
//
// options: from inputOptions(); onInputChange(value) when one is picked.
// peaks: [left, right] input peaks. connected: the engine is running.
// problem: why it isn't, if it should be. recording: the transport is recording.
// takes: this track's takes (numbered, oldest first); activeTake: the one it plays;
// takePeaks: its waveform once loaded. live: { start, levels } while recording it.
// duration/position: the song's, for placing takes.
// onSelectTake(id | null), onDeleteTake(id).
export default function InstrumentTrack({
  name,
  track,
  options,
  peaks,
  connected,
  problem,
  recording,
  takes = [],
  activeTake = null,
  takePeaks,
  live = null,
  duration = 0,
  position = 0,
  onChange,
  onInputChange,
  onRemove,
  onSelectTake,
  onDeleteTake,
}) {
  const stereo = track.inputs.length === 2
  const level = stereo ? Math.max(peaks[0], peaks[1]) : peaks[0]

  const capturing = recording && track.armed && connected
  let laneMessage
  if (!connected) laneMessage = problem ?? 'Choose your audio interface in Audio settings (the gear, top right) to hear yourself.'
  else if (capturing) laneMessage = `Recording ${describeInputs(track.inputs).toLowerCase()}`
  else if (track.armed) laneMessage = `${describeInputs(track.inputs)}. Ready to record: press the record button by Play.`
  else if (track.monitor) laneMessage = `Monitoring ${describeInputs(track.inputs).toLowerCase()}`
  else laneMessage = `${describeInputs(track.inputs)}. Turn on monitoring (headphones button) to hear yourself.`

  // Left edge and width of something in the lane, as fractions of the song
  const place = (start, length) =>
    duration > 0 ? { left: `${(start / duration) * 100}%`, width: `${(Math.max(0, length) / duration) * 100}%` } : { display: 'none' }
  const takeOptions = [
    ...takes
      .toReversed()
      .map((t) => ({ value: t.id, label: `Take ${t.number}${t.transpose ? ` (key ${formatSemitones(t.transpose)})` : ''}` })),
    { value: '', label: 'No take' },
  ]
  const showMessage = !activeTake && !live

  return (
    <div className="track track--instrument" role="group" aria-label={name}>
      <div className="track__header">
        <div className="track__title">
          <span className="track__name">{name}</span>
          <div className="track__actions">
            <button
              type="button"
              className="track__square track__arm"
              aria-pressed={Boolean(track.armed)}
              aria-label={`Record-enable ${name}`}
              title={track.armed ? 'Disable recording on this track' : 'Enable recording on this track'}
              onClick={() => onChange({ armed: !track.armed })}
            >
              <span className="record-dot" aria-hidden="true" />
            </button>
            {onRemove && (
              <button type="button" className="track__square track__remove" aria-label={`Remove ${name}`} title="Remove track" onClick={onRemove}>
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="track__controls">
          <button
            type="button"
            className="track__toggle track__toggle--monitor"
            aria-pressed={track.monitor}
            aria-label={`Monitor ${name}`}
            title={track.monitor ? 'Stop monitoring' : 'Monitor (hear yourself)'}
            onClick={() => onChange({ monitor: !track.monitor })}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
            </svg>
          </button>
          <div className="track__input">
            <span aria-hidden="true">Input</span>
            <Dropdown
              className="track__input-dropdown"
              label={`${name} input`}
              value={optionValue(track)}
              options={options}
              onChange={onInputChange}
            />
          </div>
        </div>
        <div className="gain">
          <input
            type="range"
            className="track__gain"
            min={MIN_TRACK_GAIN_DB}
            max={MAX_TRACK_GAIN_DB}
            step="0.5"
            value={gainToDb(track.gain)}
            aria-label={`${name} gain`}
            aria-valuetext={formatGain(track.gain)}
            title="Double-click for 0 dB"
            onChange={(e) => onChange({ gain: dbToGain(Number(e.target.value)) })}
            onDoubleClick={() => onChange({ gain: 1 })}
          />
          <output className="gain__value">{formatGain(track.gain)}</output>
        </div>
        <Meter peak={connected ? level : 0} label={`${name} input level`} />
      </div>
      <div
        className={`track__lane track__lane--instrument${
          capturing ? ' track__lane--recording' : track.armed ? ' track__lane--armed' : track.monitor && connected ? ' track__lane--live' : ''
        }`}
      >
        {activeTake && (
          <div
            className={`take-clip${capturing ? ' take-clip--covered' : ''}`}
            style={place(activeTake.start, activeTake.duration)}
            title={`Take ${activeTake.number}`}
          >
            {takePeaks && <Waveform peaks={takePeaks} />}
          </div>
        )}
        {live && (
          <div className="take-clip take-clip--live" style={place(live.start, position - live.start)}>
            <Waveform peaks={levelPeaks(live.levels)} />
          </div>
        )}
        {showMessage && <span className="track__lane-message">{laneMessage}</span>}
        {takes.length > 0 && !capturing && (
          <div className="take-picker">
            <Dropdown
              className="take-picker__dropdown"
              label={`${name} take`}
              value={activeTake?.id ?? ''}
              options={takeOptions}
              onChange={(value) => onSelectTake(value || null)}
            />
            {activeTake && (
              <button
                type="button"
                className="track__square take-picker__delete"
                aria-label={`Delete take ${activeTake.number}`}
                title="Move this take to the Trash"
                onClick={() => onDeleteTake(activeTake.id)}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
