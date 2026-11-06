import { describe, expect, it } from 'vitest'
import {
  calibrationOffset,
  findPulses,
  offsetKey,
  recordOffsetMs,
  sanitizeReference,
  sanitizeSegments,
  takePasses,
  takeStart,
  takesOnTrack,
} from './recording.js'

describe('takeStart', () => {
  const reference = { epochMs: 1_000_000, songTime: 10 }

  it('places the first frame at the song time heard when it was captured', () => {
    expect(takeStart({ startEpochMs: 1_000_500, reference })).toBeCloseTo(10.5)
    expect(takeStart({ startEpochMs: 999_000, reference })).toBeCloseTo(9)
  })

  it('takes off the input latency and adds the calibrated offset', () => {
    expect(takeStart({ startEpochMs: 1_000_500, reference, inputLatencyMs: 5 })).toBeCloseTo(10.495)
    expect(takeStart({ startEpochMs: 1_000_500, reference, inputLatencyMs: 5, offsetMs: -3 })).toBeCloseTo(10.492)
  })

  it('counts song time at the playback speed', () => {
    expect(takeStart({ startEpochMs: 1_001_000, reference, speed: 0.5 })).toBeCloseTo(10.5)
  })
})

describe('sanitizeReference', () => {
  const now = 1_700_000_000_000

  it('accepts a recent reference', () => {
    expect(sanitizeReference({ epochMs: now - 50, songTime: 3.2, extra: 1 }, now)).toEqual({ epochMs: now - 50, songTime: 3.2 })
  })

  it('rejects anything else', () => {
    for (const bad of [null, 5, {}, { epochMs: now, songTime: NaN }, { epochMs: 0, songTime: 1 }, { epochMs: now, songTime: -100 }]) {
      expect(() => sanitizeReference(bad, now)).toThrow('Invalid recording reference')
    }
  })
})

describe('recordOffsetMs', () => {
  const settings = { inputUid: 'in', outputUid: 'out', bufferFrames: 64 }

  it('uses the offset measured with these settings', () => {
    expect(recordOffsetMs({ ...settings, recordOffset: { key: offsetKey(settings), ms: 4.5 } })).toBe(4.5)
  })

  it('ignores one from another buffer size, or none', () => {
    expect(recordOffsetMs({ ...settings, recordOffset: { key: offsetKey({ ...settings, bufferFrames: 128 }), ms: 4.5 } })).toBe(0)
    expect(recordOffsetMs({ ...settings, recordOffset: null })).toBe(0)
  })
})

describe('findPulses', () => {
  it('finds the start of each click, whatever the level', () => {
    const samples = new Float32Array(44100)
    for (const at of [1000, 10000, 30000]) samples.fill(0.05, at, at + 10)
    samples[20000] = 0.001 // noise below the threshold
    expect(findPulses(samples, 44100)).toEqual([1000, 10000, 30000])
  })

  it('counts a ringing click once', () => {
    const samples = new Float32Array(44100)
    for (let i = 0; i < 400; i++) samples[5000 + i] = 0.4 * Math.cos(i / 3) * Math.exp(-i / 100)
    expect(findPulses(samples, 44100)).toEqual([5000])
  })

  it('finds nothing in silence', () => {
    expect(findPulses(new Float32Array(1000).fill(0.001), 44100)).toEqual([])
  })
})

describe('calibrationOffset', () => {
  it('is the median of expected minus measured', () => {
    expect(calibrationOffset([100, 500, 900, 1300], [96, 497, 895, 1290])).toBe(4.5)
    expect(calibrationOffset([100, 500, 900], [96, 497, 895])).toBe(4)
  })

  it('ignores pulses that were not heard, and stray ones', () => {
    expect(calibrationOffset([100, 500, 900, 1300], [97, 497, 897, 2000])).toBe(3)
  })

  it('is null when too few match', () => {
    expect(calibrationOffset([100, 500, 900], [97, 497])).toBeNull()
    expect(calibrationOffset([100, 500, 900], [])).toBeNull()
  })
})

describe('takesOnTrack', () => {
  it('numbers one track’s takes from 1, oldest first', () => {
    const takes = [{ id: 'a', track: 0 }, { id: 'b', track: 1 }, { id: 'c', track: 0 }]
    expect(takesOnTrack(takes, 0)).toEqual([
      { id: 'a', track: 0, number: 1 },
      { id: 'c', track: 0, number: 2 },
    ])
    expect(takesOnTrack(undefined, 0)).toEqual([])
  })
})

describe('takePasses', () => {
  // 1 kHz, so frames are ms. Playback started at song 10 s; the loop (10 s to 12 s)
  // wrapped at epoch 2000 and 4000.
  const segments = [
    { epochMs: 0, songTime: 10 },
    { epochMs: 2000, songTime: 10 },
    { epochMs: 4000, songTime: 10 },
  ]

  it('cuts the recording at each wrap', () => {
    const passes = takePasses({ frames: 5000, sampleRate: 1000, capturedAtMs: 500, segments })
    expect(passes).toEqual([
      { from: 0, to: 1500, start: 10.5, endsAtWrap: true },
      { from: 1500, to: 3500, start: 10, endsAtWrap: true },
      { from: 3500, to: 5000, start: 10, endsAtWrap: false },
    ])
  })

  it('skips stretches that ended before recording began', () => {
    const passes = takePasses({ frames: 1000, sampleRate: 1000, capturedAtMs: 2500, segments })
    expect(passes).toEqual([
      { from: 0, to: 1000, start: 10.5, endsAtWrap: true },
    ])
  })

  it('is one pass without wraps', () => {
    expect(takePasses({ frames: 100, sampleRate: 1000, capturedAtMs: 50, segments: [{ epochMs: 0, songTime: 3 }] })).toEqual([
      { from: 0, to: 100, start: 3.05, endsAtWrap: false },
    ])
  })
})

describe('sanitizeSegments', () => {
  it('takes one reference or a list, sorted', () => {
    const now = Date.now()
    expect(sanitizeSegments({ epochMs: now, songTime: 1 }, now)).toEqual([{ epochMs: now, songTime: 1 }])
    expect(sanitizeSegments([{ epochMs: now, songTime: 1 }, { epochMs: now - 5, songTime: 2 }], now).map((s) => s.songTime)).toEqual([2, 1])
    expect(() => sanitizeSegments([], now)).toThrow()
  })
})
