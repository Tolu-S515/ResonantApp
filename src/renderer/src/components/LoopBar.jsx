import { useRef } from 'react'
import { dragLoop, snapToBeat } from '../audio/loop.js'

// How close (CSS px) to an edge counts as grabbing it
const EDGE = 6

// The loop region, in a strip along the top of the ruler: filled while looping,
// grey while not. Drag an edge to resize it, the middle to move it, or anywhere
// else in the strip to draw a new one. Snaps to beats; hold Alt to place it freely.
// onDraft(region) while dragging, onCommit(region) when let go.
export default function LoopBar({ region, enabled, duration, beats, onDraft, onCommit }) {
  const stripRef = useRef(null)
  const dragRef = useRef(null)
  if (!region || duration <= 0) return <div className="loop-bar" />

  const timeAt = (event) => {
    const rect = stripRef.current.getBoundingClientRect()
    return (Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration)
  }

  function handlePointerDown(event) {
    // The ruler underneath seeks on click; this strip doesn't
    event.stopPropagation()
    event.preventDefault()
    const rect = stripRef.current.getBoundingClientRect()
    const x = event.clientX - rect.left
    const startX = (region.start / duration) * rect.width
    const endX = (region.end / duration) * rect.width
    let mode = 'create'
    // Nearer edge first, so a narrow loop can still be resized from either side
    if (Math.abs(x - startX) <= EDGE && Math.abs(x - startX) <= Math.abs(x - endX)) mode = 'start'
    else if (Math.abs(x - endX) <= EDGE) mode = 'end'
    else if (x > startX && x < endX) mode = 'move'
    dragRef.current = { mode, origin: region, grab: timeAt(event), last: null }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event) {
    const drag = dragRef.current
    if (!drag) return
    const snap = event.altKey ? undefined : (t) => snapToBeat(t, beats)
    drag.last = dragLoop({ ...drag, time: timeAt(event), duration, snap })
    onDraft(drag.last)
  }

  function handlePointerUp() {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.last) onCommit(drag.last)
  }

  return (
    <div
      ref={stripRef}
      className={`loop-bar${enabled ? ' loop-bar--on' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      title="Loop: drag the ends to resize, the middle to move, or draw a new one. Hold Alt to ignore the beats."
    >
      <div
        className="loop-bar__region"
        style={{ left: `${(region.start / duration) * 100}%`, width: `${((region.end - region.start) / duration) * 100}%` }}
      >
        <span className="loop-bar__handle loop-bar__handle--start" />
        <span className="loop-bar__handle loop-bar__handle--end" />
      </div>
    </div>
  )
}
