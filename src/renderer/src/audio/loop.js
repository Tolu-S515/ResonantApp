// Practice loop: the region in song seconds ({ start, end }), snapping it to beats,
// and the math for dragging it in the ruler.
import { MIN_LOOP_SECONDS } from '../../../shared/session.js'

// The beat nearest `time` (beats: sorted song times), or `time` if there are none
export function snapToBeat(time, beats) {
  if (!beats?.length) return time
  let lo = 0
  let hi = beats.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (beats[mid] <= time) lo = mid
    else hi = mid
  }
  return Math.abs(beats[lo] - time) <= Math.abs(beats[hi] - time) ? beats[lo] : beats[hi]
}

// Where a loop starts before one is set: the first four bars
export function defaultLoop(bars, duration) {
  if (bars.length >= 5) return { start: bars[0], end: bars[4] }
  return { start: 0, end: Math.min(duration, 8) }
}

// The region while dragging in the ruler.
// mode: 'start' / 'end' (an edge), 'move' (the whole region) or 'create' (a new one
// from where the drag began). origin: the region when the drag began. grab: song
// time where it began; time: where the pointer is now. snap(time) → snapped time.
export function dragLoop({ mode, origin, grab, time, duration, snap = (t) => t }) {
  const clamp = (t) => Math.min(Math.max(t, 0), duration)
  const min = Math.min(MIN_LOOP_SECONDS, duration)
  let start = origin.start
  let end = origin.end
  if (mode === 'start') {
    start = Math.min(clamp(snap(time)), end - min)
  } else if (mode === 'end') {
    end = Math.max(clamp(snap(time)), start + min)
  } else if (mode === 'move') {
    const length = end - start
    start = Math.min(Math.max(snap(origin.start + time - grab), 0), duration - length)
    end = start + length
  } else {
    const a = clamp(snap(grab))
    const b = clamp(snap(time))
    start = Math.min(a, b)
    end = Math.max(a, b, start + min)
    if (end > duration) {
      end = duration
      start = Math.min(start, end - min)
    }
  }
  return { start: Math.max(0, start), end: Math.min(duration, end) }
}

// Whether `time` is inside the loop
export const inLoop = (loop, time) => time >= loop.start && time < loop.end
