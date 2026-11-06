import { describe, expect, it } from 'vitest'
import { MAX_DETAIL_LENGTH, sanitizeDetails } from './session.js'

describe('sanitizeDetails', () => {
  it('keeps valid fields, trimmed', () => {
    expect(sanitizeDetails({ songName: '  War Cry ', artist: 'The Belonging Co', timeSignature: '6/8' })).toEqual({
      songName: 'War Cry',
      artist: 'The Belonging Co',
      timeSignature: '6/8',
    })
  })

  it('turns empty or blank strings into null', () => {
    expect(sanitizeDetails({ songName: '', artist: '   ' })).toEqual({ songName: null, artist: null })
    expect(sanitizeDetails({ artist: null })).toEqual({ artist: null })
  })

  it('only returns fields that were given', () => {
    expect(sanitizeDetails({ timeSignature: '3/4' })).toEqual({ timeSignature: '3/4' })
  })

  it('keeps a bar shift', () => {
    expect(sanitizeDetails({ barShift: 0 })).toEqual({ barShift: 0 })
    expect(sanitizeDetails({ barShift: 3 })).toEqual({ barShift: 3 })
    expect(sanitizeDetails({ speed: 0.75, transpose: -3 })).toEqual({ speed: 0.75, transpose: -3 })
    expect(sanitizeDetails({ speed: 0.5 })).toEqual({ speed: 0.5 })
    expect(sanitizeDetails({ speed: 1.25 })).toEqual({ speed: 1.25 })
  })

  it('drops unknown fields, so the UI cannot change anything else', () => {
    expect(sanitizeDetails({ songName: 'A', status: 'ready', files: {} })).toEqual({ songName: 'A' })
  })

  it('caps the length', () => {
    expect(sanitizeDetails({ songName: 'x'.repeat(500) }).songName).toHaveLength(MAX_DETAIL_LENGTH)
  })

  it.each([
    ['a non-object', 'War Cry'],
    ['null', null],
    ['a number name', { songName: 5 }],
    ['an unsupported time signature', { timeSignature: '5/4' }],
    ['a negative bar shift', { barShift: -1 }],
    ['a bar shift past the longest bar', { barShift: 4 }],
    ['a fractional bar shift', { barShift: 1.5 }],
    ['a string bar shift', { barShift: '1' }],
    ['a speed between steps', { speed: 0.93 }],
    ['a speed too slow', { speed: 0.45 }],
    ['a speed too fast', { speed: 1.3 }],
    ['a key change too far', { transpose: 7 }],
    ['a fractional key change', { transpose: 0.5 }],
  ])('rejects %s', (_label, input) => {
    expect(() => sanitizeDetails(input)).toThrow()
  })
})

describe('loop', () => {
  it('accepts a loop or null', () => {
    expect(sanitizeDetails({ loop: { start: 1, end: 5.5, enabled: true, x: 1 } })).toEqual({ loop: { start: 1, end: 5.5, enabled: true } })
    expect(sanitizeDetails({ loop: null })).toEqual({ loop: null })
  })

  it('rejects a bad one', () => {
    for (const loop of [{}, { start: 2, end: 2.2, enabled: true }, { start: -1, end: 4, enabled: true }, { start: 1, end: 4, enabled: 'yes' }, 7]) {
      expect(() => sanitizeDetails({ loop })).toThrow('Invalid loop')
    }
  })
})
