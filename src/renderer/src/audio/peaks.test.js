import { describe, expect, it } from 'vitest'
import { peaksToColumns } from './peaks.js'

const peaks = (pairs) => ({ length: pairs.length, data: pairs.flat() })

describe('peaksToColumns', () => {
  it('keeps one pair per column when sizes match', () => {
    const { mins, maxs } = peaksToColumns(peaks([[-10, 20], [-30, 40]]), 2)
    expect([...mins]).toEqual([-10, -30])
    expect([...maxs]).toEqual([20, 40])
  })

  it('takes the extremes of every peak a column covers', () => {
    const { mins, maxs } = peaksToColumns(peaks([[-10, 20], [-50, 5], [-1, 90], [-2, 3]]), 2)
    expect([...mins]).toEqual([-50, -2])
    expect([...maxs]).toEqual([20, 90])
  })

  it('never skips a peak when columns do not divide evenly', () => {
    const pairs = [[-1, 1], [-2, 2], [-99, 99], [-3, 3], [-4, 4]]
    const { mins, maxs } = peaksToColumns(peaks(pairs), 3)
    expect(Math.min(...mins)).toBe(-99)
    expect(Math.max(...maxs)).toBe(99)
  })

  it('repeats peaks when there are more columns than peaks', () => {
    const { mins, maxs } = peaksToColumns(peaks([[-10, 20], [-30, 40]]), 4)
    expect([...mins]).toEqual([-10, -10, -30, -30])
    expect([...maxs]).toEqual([20, 20, 40, 40])
  })

  it('handles empty peaks', () => {
    const { mins, maxs } = peaksToColumns(peaks([]), 3)
    expect([...mins]).toEqual([0, 0, 0])
    expect([...maxs]).toEqual([0, 0, 0])
  })
})
