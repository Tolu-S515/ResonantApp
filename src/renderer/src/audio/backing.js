// The backing level (everything but the live instrument), remembered between
// sessions on this computer. In dB: BACKING_MIN_DB means off.

export const BACKING_MIN_DB = -40
export const BACKING_MAX_DB = 6
const KEY = 'resonant.backingDb'
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export const backingGain = (db) => (db <= BACKING_MIN_DB ? 0 : 10 ** (db / 20))

export function loadBackingDb() {
  try {
    const raw = localStorage.getItem(KEY)
    const saved = Number(raw)
    return raw !== null && Number.isFinite(saved) ? clamp(saved, BACKING_MIN_DB, BACKING_MAX_DB) : 0
  } catch {
    return 0
  }
}

export function saveBackingDb(db) {
  try {
    localStorage.setItem(KEY, String(db))
  } catch {
    // Not saved; it still applies for now
  }
}
