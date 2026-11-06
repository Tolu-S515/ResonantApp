import { describe, expect, it } from 'vitest'
import {
  chordIndexAt,
  chordLabel,
  chordNumeral,
  chordsAround,
  simplifyChord,
  simplifyChords,
  transposeChord,
} from './chords.js'

const chords = [
  { time: 0.5, chord: 'A' },
  { time: 2, chord: 'F#m7' },
  { time: 4, chord: 'D/F#' },
  { time: 6, chord: 'N' },
]

describe('chordIndexAt', () => {
  it('finds the change in effect, including exactly on a change', () => {
    expect(chordIndexAt(chords, 0)).toBe(-1)
    expect(chordIndexAt(chords, 0.5)).toBe(0)
    expect(chordIndexAt(chords, 3.99)).toBe(1)
    expect(chordIndexAt(chords, 4)).toBe(2)
    expect(chordIndexAt(chords, 100)).toBe(3)
    expect(chordIndexAt([], 1)).toBe(-1)
  })
})

describe('chordsAround', () => {
  it('gives the previous, current and next chord', () => {
    expect(chordsAround(chords, 3)).toEqual({ index: 1, previous: 'A', current: 'F#m7', next: 'D/F#' })
  })

  it('shows the first chord before the song gets there', () => {
    expect(chordsAround(chords, 0)).toEqual({ index: 0, previous: null, current: 'A', next: 'F#m7' })
  })

  it('skips a no-chord intro at the start, but not later on', () => {
    const intro = [{ time: 0, chord: 'N' }, { time: 3, chord: 'E' }, { time: 5, chord: 'N' }]
    expect(chordsAround(intro, 1)).toEqual({ index: 1, previous: null, current: 'E', next: 'N' })
    expect(chordsAround(intro, 4)).toEqual({ index: 1, previous: 'N', current: 'E', next: 'N' })
    expect(chordsAround(intro, 6)).toEqual({ index: 2, previous: 'E', current: 'N', next: null })
  })

  it('has nothing after the last', () => {
    expect(chordsAround(chords, 7)).toEqual({ index: 3, previous: 'D/F#', current: 'N', next: null })
  })
})

describe('transposeChord', () => {
  it('moves the root and keeps the quality', () => {
    expect(transposeChord('A', 2)).toBe('B')
    expect(transposeChord('F#m7', 2)).toBe('Abm7')
    expect(transposeChord('Dmaj7', -1)).toBe('C#maj7')
    expect(transposeChord('E6', 0)).toBe('E6')
  })

  it('moves the bass note of a slash chord too', () => {
    expect(transposeChord('D/F#', -2)).toBe('C/E')
    expect(transposeChord('A/C#', 3)).toBe('C/E')
  })

  it('leaves no-chord and unknown labels alone', () => {
    expect(transposeChord('N', 2)).toBe('N')
    expect(transposeChord('?', 2)).toBe('?')
  })
})

describe('simplifyChord', () => {
  it('keeps only the root and whether it is minor', () => {
    expect(simplifyChord('F#m7')).toBe('F#m')
    expect(simplifyChord('Dmaj7')).toBe('D')
    expect(simplifyChord('A6')).toBe('A')
    expect(simplifyChord('E7')).toBe('E')
    expect(simplifyChord('Bdim')).toBe('Bm')
    expect(simplifyChord('Esus4')).toBe('E')
    expect(simplifyChord('Am')).toBe('Am')
  })

  it('keeps the bass note of a slash chord, and leaves no-chord alone', () => {
    expect(simplifyChord('D6/F#')).toBe('D/F#')
    expect(simplifyChord('C#m7/E')).toBe('C#m/E')
    expect(simplifyChord('N')).toBe('N')
  })
})

describe('simplifyChords', () => {
  it('merges changes that simplify to the same chord', () => {
    const detailed = [
      { time: 0, chord: 'A' },
      { time: 2, chord: 'Amaj7' },
      { time: 4, chord: 'A6' },
      { time: 6, chord: 'F#m7' },
      { time: 8, chord: 'F#m' },
    ]
    expect(simplifyChords(detailed)).toEqual([
      { time: 0, chord: 'A' },
      { time: 6, chord: 'F#m' },
    ])
  })
})

describe('chordLabel', () => {
  it('shows no-chord as nothing', () => {
    expect(chordLabel('N')).toBe('')
    expect(chordLabel('Am')).toBe('Am')
  })
})

describe('chordNumeral', () => {
  it('numbers chords in a major key, lowercase for minor', () => {
    expect(['A', 'Bm', 'C#m', 'D', 'E', 'F#m'].map((c) => chordNumeral(c, 'A', 'major'))).toEqual([
      'I',
      'ii',
      'iii',
      'IV',
      'V',
      'vi',
    ])
  })

  it('marks chords from outside the key', () => {
    expect(chordNumeral('G', 'A', 'major')).toBe('♭VII')
    expect(chordNumeral('C', 'A', 'major')).toBe('♭III')
    expect(chordNumeral('Dm', 'A', 'major')).toBe('iv')
  })

  it('uses the natural minor scale in a minor key', () => {
    expect(['Am', 'C', 'Dm', 'Em', 'F', 'G', 'E'].map((c) => chordNumeral(c, 'A', 'minor'))).toEqual([
      'i',
      'III',
      'iv',
      'v',
      'VI',
      'VII',
      'V',
    ])
  })

  it('handles flat keys and other spellings', () => {
    expect(chordNumeral('Cm', 'Eb', 'major')).toBe('vi')
    expect(chordNumeral('G#', 'Eb', 'major')).toBe('IV')
    expect(chordNumeral('Bb', 'Eb', 'major')).toBe('V')
  })

  it('gives a slash chord its bass as a scale degree', () => {
    expect(chordNumeral('D/F#', 'A', 'major')).toBe('IV/6')
    expect(chordNumeral('A/C#', 'A', 'major')).toBe('I/3')
    expect(chordNumeral('A/G', 'A', 'major')).toBe('I/♭7')
  })

  it('has no number for no-chord or an unknown key', () => {
    expect(chordNumeral('N', 'A', 'major')).toBeNull()
    expect(chordNumeral('A', undefined, 'major')).toBeNull()
  })
})
