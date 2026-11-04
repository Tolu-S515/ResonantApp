// Audio interface and instrument-track settings. Shared so the UI and the
// main-process validation agree on the rules. Matches native/audio-engine limits.

export const BUFFER_SIZES = [32, 64, 128, 256, 512]
export const DEFAULT_BUFFER_FRAMES = 64
export const MAX_TRACKS = 8
export const MAX_INPUT_CHANNEL = 63
// Instrument gain goes up to +24 dB, for quiet sources (a passive pickup, a soft mic)
export const MAX_TRACK_GAIN_DB = 24
// Bottom of the instrument gain slider; at the bottom it's off
export const MIN_TRACK_GAIN_DB = -60
export const dbToGain = (db) => (db <= MIN_TRACK_GAIN_DB ? 0 : 10 ** (db / 20))
export const gainToDb = (gain) => (gain <= 0 ? MIN_TRACK_GAIN_DB : Math.max(MIN_TRACK_GAIN_DB, 20 * Math.log10(gain)))
export const MAX_TRACK_GAIN = dbToGain(MAX_TRACK_GAIN_DB) // ≈ 15.85
const MAX_UID_LENGTH = 512

const isChannel = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_INPUT_CHANNEL

function uid(value, key) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_UID_LENGTH) throw new Error(`Invalid ${key}`)
  return value
}

// Which interface to use: { inputUid, outputUid, name, bufferFrames }, any subset.
// Returns only recognised, valid fields. Throws on anything else.
export function sanitizeDeviceSettings(input) {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid audio settings')
  const settings = {}
  for (const key of ['inputUid', 'outputUid']) {
    if (key in input) settings[key] = uid(input[key], key)
  }
  if ('name' in input) {
    if (input.name !== null && typeof input.name !== 'string') throw new Error('Invalid name')
    settings.name = input.name?.slice(0, 200) ?? null
  }
  if ('bufferFrames' in input) {
    if (!BUFFER_SIZES.includes(input.bufferFrames)) throw new Error('Invalid buffer size')
    settings.bufferFrames = input.bufferFrames
  }
  return settings
}

// One instrument track: { left, right, gain, pan, monitor }, all required.
// left is the (0-based) input channel; right is the second channel of a stereo pair, or -1.
export function sanitizeTrack(index, input) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_TRACKS) throw new Error('Invalid track index')
  if (typeof input !== 'object' || input === null) throw new Error('Invalid track settings')
  const { left, right, gain, pan, monitor } = input
  if (!isChannel(left)) throw new Error('Invalid input channel')
  if (right !== -1 && (!isChannel(right) || right === left)) throw new Error('Invalid second input channel')
  if (typeof gain !== 'number' || !(gain >= 0 && gain <= MAX_TRACK_GAIN)) throw new Error('Invalid gain')
  if (typeof pan !== 'number' || !(pan >= -1 && pan <= 1)) throw new Error('Invalid pan')
  if (typeof monitor !== 'boolean') throw new Error('Invalid monitor setting')
  return { left, right, gain, pan, monitor }
}

// Instrument tracks ("My Instrument 1", "My Instrument 2", …): which inputs each
// one plays, at what level. Saved app-wide, since they describe your setup rather
// than the song. Monitoring isn't saved: it's off whenever a player opens.
// inputs: one channel (mono) or two (a stereo pair), 0-based. Each input belongs
// to one track at most: two mono tracks on In 1 and In 2 make dual mono.
export const DEFAULT_INSTRUMENTS = [{ inputs: [0], gain: 1, pan: 0 }]

function sanitizeInstrument(input) {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid instrument track')
  const { inputs, gain, pan } = input
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2 || !inputs.every(isChannel)) {
    throw new Error('Invalid instrument inputs')
  }
  if (inputs.length === 2 && inputs[0] === inputs[1]) throw new Error('Invalid instrument inputs')
  if (typeof gain !== 'number' || !(gain >= 0 && gain <= MAX_TRACK_GAIN)) throw new Error('Invalid gain')
  if (typeof pan !== 'number' || !(pan >= -1 && pan <= 1)) throw new Error('Invalid pan')
  return { inputs: [...inputs], gain, pan }
}

// The whole list, 1 to MAX_TRACKS tracks, no input used twice. Throws on anything invalid.
export function sanitizeInstruments(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TRACKS) throw new Error('Invalid instrument tracks')
  const tracks = list.map(sanitizeInstrument)
  const inputs = tracks.flatMap((t) => t.inputs)
  if (new Set(inputs).size !== inputs.length) throw new Error('Two instrument tracks use the same input')
  return tracks
}

// What the engine needs for one instrument track
export function engineTrack({ inputs, gain, pan }, monitor) {
  return { left: inputs[0], right: inputs[1] ?? -1, gain, pan, monitor }
}
