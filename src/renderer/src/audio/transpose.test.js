import { describe, expect, it } from 'vitest'
import { formatSemitones, formatSpeed, transposeKey } from './transpose.js'

describe('transposeKey', () => {
  it('moves up and down, wrapping round the octave', () => {
    expect(transposeKey('A', 2)).toBe('B')
    expect(transposeKey('C', -1)).toBe('B')
    expect(transposeKey('Bb', 3)).toBe('C#')
    expect(transposeKey('Eb', 0)).toBe('Eb')
    expect(transposeKey('F#', -6)).toBe('C')
  })

  it('understands other spellings, and leaves unknown names alone', () => {
    expect(transposeKey('Db', 1)).toBe('D')
    expect(transposeKey('A#', 0)).toBe('Bb')
    expect(transposeKey('H', 2)).toBe('H')
  })
})

describe('formatting', () => {
  it('shows semitones with a sign', () => {
    expect(formatSemitones(2)).toBe('+2')
    expect(formatSemitones(-3)).toBe('−3')
    expect(formatSemitones(0)).toBe('0')
  })

  it('shows speed as a percentage', () => {
    expect(formatSpeed(0.75)).toBe('75%')
    expect(formatSpeed(1)).toBe('100%')
  })
})
