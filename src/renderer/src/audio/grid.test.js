import { describe, expect, it } from 'vitest'
import { CLICK_SOUNDS, barStarts, beatGrid, clickEvents, fitSteadyTempo, isBarStart, isSteady, thinningStep } from './grid.js'

// Deterministic "random" jitter so tests are repeatable
function jitter(i, amount) {
  return Math.sin(i * 12.9898) * amount
}

// 120 BPM from 0.5s: 0.5, 1.0, 1.5, ...
const steadyBeats = (count, amount = 0) => Array.from({ length: count }, (_, i) => 0.5 + i * 0.5 + jitter(i, amount))

// Beats at `bpm` from `start` for `count` beats, with optional jitter
const run = (start, bpm, count, amount = 0, seed = 0) =>
  Array.from({ length: count }, (_, i) => start + (i * 60) / bpm + jitter(i + seed, amount))

// Lands on a grid point (within tolerance) of a grid with this offset and period
const onGrid = (t, fit, tolerance = 0.005) => {
  const n = Math.round((t - fit.offset) / fit.period)
  return Math.abs(t - (fit.offset + n * fit.period)) <= tolerance
}

describe('fitSteadyTempo', () => {
  it('recovers tempo and phase from jittery beats', () => {
    const fit = fitSteadyTempo(steadyBeats(200, 0.01))
    expect(fit.period).toBeCloseTo(0.5, 3)
    expect(onGrid(0.5, fit)).toBe(true)
    expect(fit.rms).toBeLessThan(0.01)
    expect(isSteady(fit)).toBe(true)
  })

  it('is not thrown off by a missed beat or an extra one', () => {
    const beats = steadyBeats(100)
    beats.splice(40, 1) // missed
    beats.splice(60, 0, beats[60] + 0.01) // doubled
    const fit = fitSteadyTempo(beats)
    expect(fit.period).toBeCloseTo(0.5, 4)
    expect(fit.rms).toBeLessThan(0.002)
  })

  it('ignores an intro tracked at the wrong tempo', () => {
    // Like the test song: intro detected at 139.7 BPM, the rest a steady 148
    const intro = run(0.4, 139.7, 40)
    const song = run(intro.at(-1) + 60 / 148, 148, 400, 0.004)
    const fit = fitSteadyTempo([...intro, ...song])
    expect(60 / fit.period).toBeCloseTo(148, 1)
    expect(song.every((t) => onGrid(t, fit, 0.01))).toBe(true)
    expect(isSteady(fit)).toBe(true)
  })

  it('ignores a messy breakdown', () => {
    const beats = run(0.5, 120, 300, 0.003)
    for (let i = 140; i < 170; i++) beats[i] += jitter(i * 7, 0.06) // ±60 ms
    const fit = fitSteadyTempo(beats)
    expect(60 / fit.period).toBeCloseTo(120, 2)
    expect(isSteady(fit)).toBe(true)
  })

  it('does not call a song with a real tempo change steady', () => {
    const first = run(0.5, 120, 150)
    const second = run(first.at(-1) + 60 / 132, 132, 150)
    expect(isSteady(fitSteadyTempo([...first, ...second]))).toBe(false)
  })

  it('does not call a song that keeps speeding up steady', () => {
    // 100 BPM accelerating to ~140 BPM
    let t = 0
    const beats = Array.from({ length: 120 }, (_, i) => (t += 0.6 - i * 0.0015))
    expect(isSteady(fitSteadyTempo(beats))).toBe(false)
  })

  it('needs enough beats', () => {
    expect(fitSteadyTempo([0.5, 1, 1.5])).toBeNull()
  })
})

describe('beatGrid', () => {
  it('uses an evenly spaced grid for steady songs, from the start to the end', () => {
    const { steady, beats } = beatGrid(steadyBeats(20, 0.004), 10.2)
    expect(steady).toBe(true)
    // Extends back before the first detected beat (0.5 s) to the start of the song
    expect(beats[0]).toBeGreaterThanOrEqual(0)
    expect(beats[0]).toBeLessThan(0.5)
    expect(beats.at(-1)).toBeLessThanOrEqual(10.2)
    const gaps = beats.slice(1).map((t, i) => t - beats[i])
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9)
    expect(gaps[0]).toBeCloseTo(0.5, 2) // only 20 jittery beats to fit
  })

  it('carries the steady tempo back through a wrong-tempo intro', () => {
    const intro = run(0.4, 139.7, 40)
    const song = run(intro.at(-1) + 60 / 148, 148, 400)
    const { steady, beats, bpm } = beatGrid([...intro, ...song], song.at(-1) + 1)
    expect(steady).toBe(true)
    expect(bpm).toBeCloseTo(148, 1)
    // Every gap, intro included, is one 148 BPM beat
    const gaps = beats.slice(1).map((t, i) => t - beats[i])
    expect(gaps.every((g) => Math.abs(g - 60 / 148) < 1e-6)).toBe(true)
    expect(beats[0]).toBeLessThan(60 / 148)
  })

  it('keeps the detected beats when the tempo changes', () => {
    const first = run(0.5, 120, 150)
    const detected = [...first, ...run(first.at(-1) + 60 / 132, 132, 150)]
    expect(beatGrid(detected, 200)).toEqual({ steady: false, beats: detected.filter((b) => b <= 200) })
  })
})

describe('isBarStart', () => {
  it('counts bars from the first beat, shifted by barShift', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => isBarStart(i, 4))).toEqual([true, false, false, false, true, false])
    expect([0, 1, 2, 3, 4, 5].map((i) => isBarStart(i, 4, 1))).toEqual([false, true, false, false, false, true])
    expect([0, 1, 2, 3].map((i) => isBarStart(i, 3, -1))).toEqual([false, false, true, false])
  })
})

describe('clickEvents', () => {
  const beats = [0, 1, 2, 3, 4, 5, 6, 7]
  // A = accent sound, . = normal sound
  const pattern = (events) => events.map((e) => (e.sound === CLICK_SOUNDS.accent ? 'A' : '.')).join('')

  it('accents the first beat of each bar in 4/4', () => {
    expect(pattern(clickEvents(beats))).toBe('A...A...')
  })

  it('uses 3 beats per bar in 3/4', () => {
    expect(pattern(clickEvents(beats, { timeSignature: '3/4' }))).toBe('A..A..A.')
  })

  it('moves the accent with barShift', () => {
    expect(pattern(clickEvents(beats, { barShift: 2 }))).toBe('..A...A.')
  })

  it('in 8ths, accents once every 8 clicks (Accent-2-3-4-5-6-7-8)', () => {
    const events = clickEvents([0, 1, 2, 3, 4], { subdivision: 'eighth' })
    expect(pattern(events)).toBe('A.......A.')
    // Accents land on the first beat of each bar
    expect(events.filter((e) => e.sound === CLICK_SOUNDS.accent).map((e) => e.time)).toEqual([0, 4])
  })

  it('in 8ths, keeps accents in line with a shifted bar start', () => {
    expect(pattern(clickEvents([0, 1, 2, 3, 4], { subdivision: 'eighth', barShift: 1 }))).toBe('..A.......')
  })

  it('in 8ths, accents once per bar in 3/4 and 6/8', () => {
    expect(pattern(clickEvents([0, 1, 2, 3], { timeSignature: '3/4', subdivision: 'eighth' }))).toBe('A.....A.')
    expect(pattern(clickEvents([0, 1, 2], { timeSignature: '6/8', subdivision: 'eighth' }))).toBe('A.....A..')
  })

  it('in 16ths, accents every 4 clicks (each beat)', () => {
    expect(pattern(clickEvents([0, 1, 2], { subdivision: 'sixteenth' }))).toBe('A...A...A...')
  })

  it('places eighths half-way between beats, following uneven beats', () => {
    const events = clickEvents([0, 1, 3], { subdivision: 'eighth' })
    expect(events.map((e) => e.time)).toEqual([0, 0.5, 1, 2, 3, 4]) // last beat reuses the previous gap
  })

  it('splits 6/8 beats into three eighths', () => {
    const events = clickEvents([0, 1.5, 3], { timeSignature: '6/8', subdivision: 'eighth' })
    expect(events.map((e) => e.time)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4])
  })
})

describe('barStarts', () => {
  it('returns the times of bar starts', () => {
    expect(barStarts([0, 1, 2, 3, 4, 5, 6, 7, 8], { timeSignature: '4/4', barShift: 1 })).toEqual([1, 5])
  })
})

describe('thinningStep', () => {
  it('draws everything when there is room', () => {
    expect(thinningStep(10, 1000, 40)).toBe(1)
  })

  it('skips items so labels stay apart', () => {
    // 100 bars in 1000px = 10px apart; need 40px → every 4th
    expect(thinningStep(100, 1000, 40)).toBe(4)
  })
})
