// Peaks files (written by process.py) hold one [min, max] pair per block of samples,
// as integers in [-127, 127], flattened: [min0, max0, min1, max1, ...].

export const PEAK_SCALE = 127

// Reduces peaks to exactly `columns` [min, max] pairs (still in -127..127), one per
// pixel column. Each column covers its share of the song; when there are more
// columns than peaks, neighbouring columns repeat the same peak.
export function peaksToColumns(peaks, columns) {
  const { data, length } = peaks
  const mins = new Int8Array(columns)
  const maxs = new Int8Array(columns)
  if (length === 0 || columns <= 0) return { mins, maxs }

  for (let x = 0; x < columns; x++) {
    const start = Math.floor((x * length) / columns)
    const end = Math.max(start + 1, Math.floor(((x + 1) * length) / columns))
    let min = PEAK_SCALE
    let max = -PEAK_SCALE
    for (let i = start; i < end; i++) {
      if (data[2 * i] < min) min = data[2 * i]
      if (data[2 * i + 1] > max) max = data[2 * i + 1]
    }
    mins[x] = min
    maxs[x] = max
  }
  return { mins, maxs }
}
