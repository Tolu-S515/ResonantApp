// Key and tempo after a practice speed / key change

// The spellings the analysis (Essentia) uses
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const ALIASES = { Db: 'C#', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb' }

// "A" + 2 → "B"; an unknown name comes back unchanged
export function transposeKey(key, semitones) {
  const index = NOTES.indexOf(ALIASES[key] ?? key)
  if (index === -1) return key
  return NOTES[(((index + semitones) % 12) + 12) % 12]
}

// +2, −3, 0 (with a real minus sign)
export function formatSemitones(semitones) {
  if (semitones === 0) return '0'
  return semitones > 0 ? `+${semitones}` : `−${-semitones}`
}

export const formatSpeed = (speed) => `${Math.round(speed * 100)}%`
