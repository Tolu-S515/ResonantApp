// Level meters: input peaks (linear, 0..1) drawn on a dB scale

export const METER_FLOOR_DB = -60
// At or above this the interface is clipping (or about to)
export const CLIP_PEAK = 0.99

// 0 at the floor or below, 1 at 0 dBFS
export function meterFraction(peak) {
  if (!(peak > 0)) return 0
  const db = 20 * Math.log10(peak)
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
}
