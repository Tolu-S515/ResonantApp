import { describe, expect, it } from 'vitest'
import { epochOffset } from './clock.js'

describe('epochOffset', () => {
  it('reads the page clock the moment the wall clock ticks over', () => {
    let perf = 100.3
    const perfNow = () => (perf += 0.05)
    const dateNow = () => Math.floor(1_000_000.7 + perf - 100.3) // ticks at perf 100.6
    const offset = epochOffset(dateNow, perfNow)
    // Wall clock = page clock + 999_900.4; the reading is within a couple of steps of that
    expect(Math.abs(offset - 999_900.4)).toBeLessThan(0.15)
  })

  it('gives up waiting after a couple of ms', () => {
    let perf = 0
    expect(epochOffset(() => 5, () => (perf += 0.5))).toBe(5 - 2.5)
  })
})
