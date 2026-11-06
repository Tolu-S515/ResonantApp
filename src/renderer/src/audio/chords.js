// Chord display: which chord is playing, and chord names in a changed key.
// A session's chords are a list of changes, [{ time, chord }], sorted by time (song
// seconds, so they hold at any practice speed). "N" means no chord.
import { noteIndex, transposeKey } from './transpose.js'

// Index of the change in effect at `time`, or -1 before the first one
export function chordIndexAt(chords, time) {
  let lo = 0
  let hi = chords.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chords[mid].time <= time) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// The chords either side of `time`, as names (null where there is none). Before the
// song's first chord (or during a no-chord intro) it shows that first chord, so the
// display is never blank at the start.
export function chordsAround(chords, time) {
  const first = chords.findIndex((c) => c.chord !== 'N')
  const at = chordIndexAt(chords, time)
  const i = Math.max(at, first)
  return {
    index: i,
    previous: at < first ? null : (chords[i - 1]?.chord ?? null),
    current: chords[i]?.chord ?? null,
    next: chords[i + 1]?.chord ?? null,
  }
}

const CHORD = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/

// "F#m7" + 2 → "Abm7", "D/F#" − 2 → "C/E". Anything unrecognised (like "N") comes
// back unchanged.
export function transposeChord(chord, semitones) {
  if (!semitones) return chord
  const match = CHORD.exec(chord)
  if (!match) return chord
  const [, root, quality, bass] = match
  return transposeKey(root, semitones) + quality + (bass ? `/${transposeKey(bass, semitones)}` : '')
}

// Just the root and major/minor: "F#m7" → "F#m", "Dmaj7" → "D", "A6" → "A",
// "Bdim" → "Bm", "Esus4" → "E". A slash chord keeps its bass note ("D6/F#" → "D/F#").
export function simplifyChord(chord) {
  const match = CHORD.exec(chord)
  if (!match) return chord
  const [, root, quality, bass] = match
  const minor = /^(m(?!aj)|min|dim)/.test(quality)
  return root + (minor ? 'm' : '') + (bass ? `/${bass}` : '')
}

// Simplified chords, with changes that now repeat (A → Amaj7 → A6) merged into one
export function simplifyChords(chords) {
  const out = []
  for (const { time, chord } of chords) {
    const simple = simplifyChord(chord)
    if (out.at(-1)?.chord !== simple) out.push({ time, chord: simple })
  }
  return out
}

// Roman numerals for each semitone above the tonic. In a major key the scale is
// I II III IV V VI VII; in a minor key, the natural minor (i ii III iv v VI VII), so
// its flat 3rd, 6th and 7th need no accidental. Other notes get ♭ or ♯.
const DEGREES = {
  major: ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'],
  minor: ['I', '♭II', 'II', 'III', '♯III', 'IV', '♯IV', 'V', 'VI', '♯VI', 'VII', '♯VII'],
}
const ARABIC = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7' }

// A simplified chord ("F#m", "D/F#") as a Nashville number in roman numerals in the
// song's key: uppercase for major, lowercase for minor ("vi", "IV"). A slash chord's
// bass note is a plain scale degree ("IV/6"). Null for no-chord or an unknown key.
export function chordNumeral(chord, key, scale) {
  const match = CHORD.exec(chord)
  const tonic = noteIndex(key)
  if (!match || tonic === -1) return null
  const [, root, quality, bass] = match
  const degrees = DEGREES[scale] ?? DEGREES.major
  const degree = (note) => degrees[(((noteIndex(note) - tonic) % 12) + 12) % 12]
  const numeral = degree(root)
  const minor = quality.startsWith('m') && !quality.startsWith('maj')
  const shown = minor ? numeral.toLowerCase() : numeral
  if (!bass) return shown
  const bassDegree = degree(bass)
  return `${shown}/${bassDegree.replace(/[IV]+/, (r) => ARABIC[r])}`
}

// How a chord name is shown: "N" (nothing playing a chord) as nothing at all
export const chordLabel = (chord) => (chord === 'N' ? '' : chord)
