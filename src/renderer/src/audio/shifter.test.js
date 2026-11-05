import { describe, expect, it, vi } from 'vitest'

// shifter.js imports its worklet and WebAssembly through Vite; only the pure helpers are tested here
vi.mock('rubberband-wasm/dist/rubberband.wasm?url', () => ({ default: 'rubberband.wasm' }))
vi.mock('./shifter-processor.js?worker&url', () => ({ default: 'shifter-processor.js' }))
const { burstDelays, median } = await import('./shifter.js')

describe('burstDelays', () => {
  it('finds how late each burst comes out, allowing for the speed', () => {
    const rate = 1000
    const samples = new Float32Array(5000)
    // Bursts at song times 0.5 and 1.0 played at 0.5× should come out at 1.0 s and 2.0 s; here 40 ms late
    samples[1040] = 0.5
    samples[2040] = 0.5
    const delays = burstDelays(samples, rate, [0.5, 1], 0.5)
    expect(delays[0]).toBeCloseTo(0.04)
    expect(delays[1]).toBeCloseTo(0.04)
  })

  it('ignores anything below the threshold', () => {
    const samples = new Float32Array(3000)
    samples[1010] = 0.05 // ripple
    samples[1030] = 0.4
    expect(burstDelays(samples, 1000, [1], 1)[0]).toBeCloseTo(0.03)
  })
})

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})
