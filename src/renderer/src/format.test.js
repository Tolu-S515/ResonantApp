import { describe, expect, it } from 'vitest'
import { formatGain, formatTime } from './format.js'

describe('formatGain', () => {
  it.each([
    [1, '0.0 dB'],
    [1.5, '+3.5 dB'],
    [2.5, '+8.0 dB'],
    [0.5, '-6.0 dB'],
    [0.01, '-40.0 dB'],
    [0, '-∞ dB'],
    [0.9999, '0.0 dB'], // never "-0.0"
  ])('%s → %s', (gain, text) => {
    expect(formatGain(gain)).toBe(text)
  })
})

describe('formatTime', () => {
  it('formats minutes and seconds', () => {
    expect(formatTime(83.4)).toBe('1:23')
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(-5)).toBe('0:00')
  })
})
