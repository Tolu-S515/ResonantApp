import { CLIP_PEAK, meterFraction } from '../audio/meter.js'
import './Meter.css'

// Horizontal level meter for one input peak (linear 0..1)
export default function Meter({ peak, label }) {
  const clipping = peak >= CLIP_PEAK
  return (
    <div
      className={`meter${clipping ? ' meter--clip' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Math.min(peak || 0, 1)}
    >
      <div className="meter__level" style={{ transform: `scaleX(${meterFraction(peak)})` }} />
    </div>
  )
}
