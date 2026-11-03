// What each processing status means to the user
export const STAGE_LABELS = {
  imported: 'Starting…',
  normalizing: 'Converting audio…',
  analyzing: 'Detecting key and tempo…',
  separating: 'Splitting into stems…',
  ready: 'Stems ready',
  cancelled: 'Cancelled',
}

// Statuses where processing is queued or running, so it can be cancelled
export const ACTIVE_STATUSES = ['imported', 'normalizing', 'analyzing', 'separating']

// 83.4 → "1:23"
export function formatTime(totalSeconds) {
  const safe = Math.max(0, totalSeconds || 0)
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// Slider gain (linear, 1 = unchanged) as decibels: 1 → "0.0 dB", 1.5 → "+3.5 dB", 0 → "-∞ dB"
export function formatGain(gain) {
  if (gain <= 0) return '-∞ dB'
  const db = 20 * Math.log10(gain)
  const rounded = Math.round(db * 10) / 10
  if (rounded === 0) return '0.0 dB'
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`
}
