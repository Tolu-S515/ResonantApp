import { describe, expect, it } from 'vitest'
import { mixClicks } from './click.js'

const sounds = { quarter: new Float32Array([1, 0.5]), eighth: new Float32Array([0.25]) }

describe('mixClicks', () => {
  it('places each click at the nearest sample to its time', () => {
    // 10 Hz sample rate: 0.2 s → sample 2, 0.46 s → sample 5
    const out = mixClicks(
      [
        { time: 0.2, sound: 'quarter' },
        { time: 0.46, sound: 'eighth' },
      ],
      sounds,
      10,
      8,
    )
    expect([...out]).toEqual([0, 0, 1, 0.5, 0, 0.25, 0, 0])
  })

  it('sums overlapping clicks', () => {
    const out = mixClicks(
      [
        { time: 0, sound: 'quarter' },
        { time: 0.1, sound: 'eighth' },
      ],
      sounds,
      10,
      3,
    )
    expect([...out]).toEqual([1, 0.75, 0])
  })

  it('cuts off a click at the end and skips ones outside the track', () => {
    const out = mixClicks(
      [
        { time: -1, sound: 'quarter' },
        { time: 0.3, sound: 'quarter' },
        { time: 5, sound: 'quarter' },
      ],
      sounds,
      10,
      4,
    )
    expect([...out]).toEqual([0, 0, 0, 1])
  })
})
