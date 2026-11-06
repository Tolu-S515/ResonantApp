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

// Peaks of a decoded buffer, in the same form as a peaks file ({ data, length }),
// all channels together: for takes, which have no peaks file.
export function bufferPeaks(buffer, samplesPerPeak = 512) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const length = Math.ceil(buffer.length / samplesPerPeak)
  const data = new Int8Array(length * 2)
  for (let p = 0; p < length; p++) {
    let min = 0
    let max = 0
    const end = Math.min(buffer.length, (p + 1) * samplesPerPeak)
    for (const samples of channels) {
      for (let i = p * samplesPerPeak; i < end; i++) {
        if (samples[i] < min) min = samples[i]
        else if (samples[i] > max) max = samples[i]
      }
    }
    data[2 * p] = Math.round(Math.max(-1, min) * PEAK_SCALE)
    data[2 * p + 1] = Math.round(Math.min(1, max) * PEAK_SCALE)
  }
  return { data, length }
}

// Peaks for a list of levels (0..1), drawn symmetrically: for the take being recorded
export function levelPeaks(levels) {
  const data = new Int8Array(levels.length * 2)
  levels.forEach((level, i) => {
    const v = Math.round(Math.min(1, level) * PEAK_SCALE)
    data[2 * i] = -v
    data[2 * i + 1] = v
  })
  return { data, length: levels.length }
}
