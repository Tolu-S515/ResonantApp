import { describe, expect, it } from 'vitest'
import { defaultLoop, dragLoop, inLoop, snapToBeat } from './loop.js'

const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
const snap = (t) => snapToBeat(t, beats)

describe('snapToBeat', () => {
  it('picks the nearest beat', () => {
    expect(snap(1.2)).toBe(1)
    expect(snap(1.3)).toBe(1.5)
    expect(snap(-3)).toBe(0)
    expect(snap(99)).toBe(4)
    expect(snapToBeat(1.23, [])).toBe(1.23)
  })
})

describe('defaultLoop', () => {
  it('is the first four bars, or the start of a short song', () => {
    expect(defaultLoop([0.2, 2, 4, 6, 8, 10], 60)).toEqual({ start: 0.2, end: 8 })
    expect(defaultLoop([], 5)).toEqual({ start: 0, end: 5 })
  })
})

describe('dragLoop', () => {
  const origin = { start: 1, end: 2 }
  const drag = (mode, grab, time) => dragLoop({ mode, origin, grab, time, duration: 4, snap })

  it('moves either edge, keeping half a second between them', () => {
    expect(drag('start', 1, 0.4)).toEqual({ start: 0.5, end: 2 })
    expect(drag('start', 1, 1.9)).toEqual({ start: 1.5, end: 2 })
    expect(drag('end', 2, 3.4)).toEqual({ start: 1, end: 3.5 })
    expect(drag('end', 2, 0)).toEqual({ start: 1, end: 1.5 })
  })

  it('moves the whole loop, inside the song', () => {
    expect(drag('move', 1.5, 2.6)).toEqual({ start: 2, end: 3 })
    expect(drag('move', 1.5, 9)).toEqual({ start: 3, end: 4 })
    expect(drag('move', 1.5, -9)).toEqual({ start: 0, end: 1 })
  })

  it('draws a new loop either way', () => {
    expect(drag('create', 3.1, 2.1)).toEqual({ start: 2, end: 3 })
    expect(drag('create', 3.1, 3.1)).toEqual({ start: 3, end: 3.5 })
    expect(drag('create', 3.9, 3.9)).toEqual({ start: 3.5, end: 4 })
  })
})

describe('inLoop', () => {
  it('includes the start, not the end', () => {
    expect([inLoop(origin(), 1), inLoop(origin(), 2)]).toEqual([true, false])
  })
})

function origin() {
  return { start: 1, end: 2 }
}
