import { useMemo } from 'react'
import { chordLabel, chordNumeral, chordsAround, simplifyChords, transposeChord } from '../audio/chords.js'
import './ChordDisplay.css'

// The chord playing now, large, with the next one dimmed beside it, and each one's
// Nashville number underneath. `chords` are the detected changes in the original key
// (`songKey`, `scale`); `transpose` is the key change actually playing, so the names
// always match what you hear. The numbers don't change with the key.
function ChordDisplay({ chords: detected, position, transpose, songKey, scale }) {
  // Root and major/minor only (no 7ths, 6ths, sus...)
  const chords = useMemo(() => simplifyChords(detected ?? []), [detected])

  // No chords (yet): keep the space, so the tracks don't jump when they arrive
  if (!chords.length) return <div className="chords" />

  const { index, current, next } = chordsAround(chords, position)
  const name = (chord) => (chord ? chordLabel(transposeChord(chord, transpose)) : '')
  const nextName = name(next)
  const numeral = (chord) => (chord ? chordNumeral(chord, songKey, scale) : null)

  return (
    <div className="chords" aria-label="Chords">
      {/* Empty columns balancing the arrow and next chord, so the current one stays centred */}
      <span />
      <span />
      {/* Keyed on the change, so each new chord fades in */}
      <span key={index} className="chords__current">
        {name(current)}
      </span>
      <span className="chords__arrow" aria-hidden="true">
        {nextName && '→'}
      </span>
      <span className="chords__side chords__side--next" title="Next chord">
        {nextName}
      </span>
      <span key={`n${index}`} className="chords__numeral chords__numeral--current">
        {numeral(current)}
      </span>
      <span className="chords__numeral chords__numeral--next">{nextName && numeral(next)}</span>
    </div>
  )
}

export default ChordDisplay
