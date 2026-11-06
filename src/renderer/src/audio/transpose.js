// Key and tempo after a practice speed / key change

// The spellings the analysis (Essentia) uses
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const ALIASES = { Db: 'C#', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' }

// Semitones above C: "C" → 0, "F#"/"Gb" → 6; -1 for anything that isn't a note
export const noteIndex = (note) => NOTES.indexOf(ALIASES[note] ?? note)

// "A" + 2 → "B"; an unknown name comes back unchanged
export function transposeKey(key, semitones) {
  const index = noteIndex(key)
  if (index === -1) return key
  return NOTES[(((index + semitones) % 12) + 12) % 12]
}

// +2, −3, 0 (with a real minus sign)
export function formatSemitones(semitones) {
  if (semitones === 0) return '0'
  return semitones > 0 ? `+${semitones}` : `−${-semitones}`
}

export const formatSpeed = (speed) => `${Math.round(speed * 100)}%`
