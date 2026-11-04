import { describe, expect, it } from 'vitest'
import { MAX_TRACK_GAIN, MAX_TRACK_GAIN_DB, MAX_TRACKS, dbToGain, engineTrack, gainToDb, sanitizeDeviceSettings, sanitizeInstruments, sanitizeTrack } from './audio-settings.js'

describe('sanitizeDeviceSettings', () => {
  it('keeps valid fields and drops unknown ones', () => {
    expect(
      sanitizeDeviceSettings({ inputUid: 'in:2', outputUid: 'out:1', name: 'USB AUDIO  CODEC', bufferFrames: 64, extra: 1 }),
    ).toEqual({ inputUid: 'in:2', outputUid: 'out:1', name: 'USB AUDIO  CODEC', bufferFrames: 64 })
  })

  it('allows clearing the interface', () => {
    expect(sanitizeDeviceSettings({ inputUid: null, outputUid: null })).toEqual({ inputUid: null, outputUid: null })
  })

  it.each([
    ['a non-object', 'x'],
    ['an empty uid', { inputUid: '' }],
    ['a number uid', { outputUid: 5 }],
    ['an unsupported buffer size', { bufferFrames: 100 }],
  ])('rejects %s', (_label, input) => {
    expect(() => sanitizeDeviceSettings(input)).toThrow()
  })
})

describe('sanitizeTrack', () => {
  const mono = { left: 0, right: -1, gain: 1, pan: 0, monitor: true }

  it('accepts mono and stereo tracks', () => {
    expect(sanitizeTrack(0, mono)).toEqual(mono)
    expect(sanitizeTrack(7, { ...mono, right: 1, pan: -0.5, monitor: false })).toEqual({
      left: 0,
      right: 1,
      gain: 1,
      pan: -0.5,
      monitor: false,
    })
  })

  it.each([
    ['an index past the last track', 8, mono],
    ['a fractional index', 0.5, mono],
    ['a negative channel', 0, { ...mono, left: -1 }],
    ['a stereo pair of one channel', 0, { ...mono, right: 0 }],
    ['too much gain', 0, { ...mono, gain: 20 }],
    ['NaN gain', 0, { ...mono, gain: NaN }],
    ['pan past hard right', 0, { ...mono, pan: 1.5 }],
    ['a missing monitor flag', 0, { left: 0, right: -1, gain: 1, pan: 0 }],
  ])('rejects %s', (_label, index, input) => {
    expect(() => sanitizeTrack(index, input)).toThrow()
  })
})

describe('sanitizeInstruments', () => {
  it('accepts mono and stereo tracks', () => {
    const list = [
      { inputs: [0], gain: 1, pan: 0 },
      { inputs: [2, 3], gain: 0.5, pan: -0.5, extra: true },
    ]
    expect(sanitizeInstruments(list)).toEqual([
      { inputs: [0], gain: 1, pan: 0 },
      { inputs: [2, 3], gain: 0.5, pan: -0.5 },
    ])
  })

  it('rejects bad lists and tracks', () => {
    const ok = { inputs: [0], gain: 1, pan: 0 }
    expect(() => sanitizeInstruments([])).toThrow()
    expect(() => sanitizeInstruments(Array.from({ length: MAX_TRACKS + 1 }, (_, c) => ({ ...ok, inputs: [c] })))).toThrow()
    expect(() => sanitizeInstruments([{ ...ok, inputs: [] }])).toThrow()
    expect(() => sanitizeInstruments([{ ...ok, inputs: [0, 0] }])).toThrow()
    expect(() => sanitizeInstruments([{ ...ok, inputs: [0, 1, 2] }])).toThrow()
    expect(() => sanitizeInstruments([{ ...ok, inputs: [-1] }])).toThrow()
    expect(() => sanitizeInstruments([{ ...ok, gain: 20 }])).toThrow()
    expect(() => sanitizeInstruments([{ ...ok, pan: 2 }])).toThrow()
    expect(() => sanitizeInstruments([ok, { ...ok, inputs: [0, 1] }])).toThrow('same input')
    expect(() => sanitizeInstruments('nope')).toThrow()
  })
})

describe('engineTrack', () => {
  it('maps inputs to the engine left/right channels', () => {
    expect(engineTrack({ inputs: [1], gain: 1, pan: 0.5 }, true)).toEqual({ left: 1, right: -1, gain: 1, pan: 0.5, monitor: true })
    expect(engineTrack({ inputs: [0, 1], gain: 2, pan: 0 }, false)).toEqual({ left: 0, right: 1, gain: 2, pan: 0, monitor: false })
  })
})

describe('instrument gain in dB', () => {
  it('converts both ways, with the bottom of the range meaning off', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-60)).toBe(0)
    expect(gainToDb(0)).toBe(-60)
    expect(gainToDb(dbToGain(-6))).toBeCloseTo(-6)
    expect(dbToGain(20)).toBeCloseTo(10)
  })

  it('accepts gain up to +24 dB', () => {
    expect(dbToGain(MAX_TRACK_GAIN_DB)).toBe(MAX_TRACK_GAIN)
    expect(() => sanitizeInstruments([{ inputs: [0], gain: MAX_TRACK_GAIN, pan: 0 }])).not.toThrow()
    expect(() => sanitizeInstruments([{ inputs: [0], gain: MAX_TRACK_GAIN * 1.01, pan: 0 }])).toThrow()
  })
})
