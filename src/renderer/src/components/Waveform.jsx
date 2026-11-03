import { useEffect, useRef } from 'react'
import { PEAK_SCALE, peaksToColumns } from '../audio/peaks.js'

// Draws a peaks file across the whole width of its container: one bar per
// device pixel, from that column's min to its max. Colour comes from CSS `color`.
function Waveform({ peaks }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function draw() {
      const { width, height } = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)

      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = getComputedStyle(canvas).color

      const { mins, maxs } = peaksToColumns(peaks, canvas.width)
      const mid = canvas.height / 2
      const scale = mid / PEAK_SCALE
      for (let x = 0; x < canvas.width; x++) {
        const top = mid - maxs[x] * scale
        const bottom = mid - mins[x] * scale
        // At least 1px tall so silence still shows as a centre line
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
      }
    }

    draw()
    // Redraw on resize and when the system switches light/dark (the colour changes)
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', draw)
    return () => {
      observer.disconnect()
      scheme.removeEventListener('change', draw)
    }
  }, [peaks])

  return <canvas ref={canvasRef} className="waveform" aria-hidden="true" />
}

export default Waveform
