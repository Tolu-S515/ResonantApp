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
  ])('rejects %s', (_label, input) => {
    expect(() => sanitizeDetails(input)).toThrow()
  })
})
