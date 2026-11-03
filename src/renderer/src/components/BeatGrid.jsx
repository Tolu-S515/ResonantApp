import { memo, useEffect, useRef } from 'react'
import { thinningStep } from '../audio/grid.js'

// Minimum gaps in CSS pixels; closer than this and lines/labels turn into a smear
const MIN_BEAT_SPACING = 6
const MIN_BAR_SPACING = 3
const MIN_LABEL_SPACING = 40

// Draws on a canvas that fills its parent. Redraws when `inputs` change, on
// resize, and on a light/dark switch. `draw` must depend only on `inputs`.
function useCanvas(draw, inputs) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    function redraw() {
      const { width, height } = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = getComputedStyle(canvas).color
      draw(ctx, canvas.width, canvas.height, dpr)
    }
    redraw()
    const observer = new ResizeObserver(redraw)
    observer.observe(canvas)
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', redraw)
    return () => {
      observer.disconnect()
      scheme.removeEventListener('change', redraw)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw depends only on inputs
  }, inputs)
  return canvasRef
}

function drawLines(ctx, times, duration, width, height, step, alpha, lineWidth) {
  ctx.globalAlpha = alpha
  for (let i = 0; i < times.length; i += step) {
    const x = Math.round((times[i] / duration) * width)
    ctx.fillRect(x, 0, lineWidth, height)
  }
}

// Bar lines (stronger) and beat lines (faint) across the lanes.
// memo: the player re-renders every animation frame while playing; this only
// redraws when the grid itself changes.
export const GridLines = memo(function GridLines({ beats, bars, duration }) {
  const canvasRef = useCanvas(
    (ctx, width, height, dpr) => {
      const cssWidth = width / dpr
      if (thinningStep(beats.length, cssWidth, MIN_BEAT_SPACING) === 1) {
        drawLines(ctx, beats, duration, width, height, 1, 0.1, dpr)
      }
      drawLines(ctx, bars, duration, width, height, thinningStep(bars.length, cssWidth, MIN_BAR_SPACING), 0.3, dpr)
    },
    [beats, bars, duration],
  )
  return <canvas ref={canvasRef} className="beat-grid" aria-hidden="true" />
})

// Bar ticks and numbers in the ruler. Bar 1 is the first bar start.
export const RulerBars = memo(function RulerBars({ bars, duration }) {
  const canvasRef = useCanvas(
    (ctx, width, height, dpr) => {
      const cssWidth = width / dpr
      drawLines(ctx, bars, duration, width, height * 0.35, thinningStep(bars.length, cssWidth, MIN_BAR_SPACING), 0.5, dpr)

      const labelStep = thinningStep(bars.length, cssWidth, MIN_LABEL_SPACING)
      ctx.globalAlpha = 0.8
      ctx.font = `${10 * dpr}px system-ui, sans-serif`
      ctx.textBaseline = 'bottom'
      for (let i = 0; i < bars.length; i += labelStep) {
        const x = Math.round((bars[i] / duration) * width)
        ctx.fillText(String(i + 1), x + 3 * dpr, height - 3 * dpr)
      }
    },
    [bars, duration],
  )
  return <canvas ref={canvasRef} className="ruler-bars" aria-hidden="true" />
})

