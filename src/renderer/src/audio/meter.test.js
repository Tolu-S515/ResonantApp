import { describe, expect, it } from 'vitest'
import { meterFraction } from './meter.js'

describe('meterFraction', () => {
  it('maps 0 dBFS to full and the floor to empty', () => {
    expect(meterFraction(1)).toBe(1)
    expect(meterFraction(0.001)).toBeCloseTo(0, 5) // -60 dB
  })

  it('is linear in dB', () => {
    expect(meterFraction(10 ** (-30 / 20))).toBeCloseTo(0.5, 5)
  })

  it('handles silence and overs', () => {
    expect(meterFraction(0)).toBe(0)
    expect(meterFraction(0.0001)).toBe(0)
    expect(meterFraction(1.5)).toBe(1)
    expect(meterFraction(undefined)).toBe(0)
  })
})
