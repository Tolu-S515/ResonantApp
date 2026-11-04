// Instrument-track helpers for the player (see shared/audio-settings.js for the model).
//
// A track plays one input (mono) or a stereo pair. Each input belongs to at most
// one track, so two mono tracks on In 1 and In 2 are dual mono, and a stereo track
// uses both. A new track can only be added while an input is free, and takes it.

const usedByOthers = (list, index) => new Set(list.flatMap((t, i) => (i === index ? [] : t.inputs)))

// Dropdown value for a track's current inputs
export function optionValue(track) {
  return track.inputs.length === 2 ? `stereo:${track.inputs[0]}` : `input:${track.inputs[0]}`
}

// Dropdown options for track `index` on an interface with `channelCount` inputs:
// Input 1, Input 2, Stereo (bigger interfaces name the pair: Stereo 3+4).
// Inputs another track has are disabled.
export function inputOptions(list, index, channelCount) {
  const count = Math.max(1, channelCount)
  const taken = usedByOthers(list, index)
  const options = Array.from({ length: count }, (_, c) => ({
    value: `input:${c}`,
    label: `Input ${c + 1}`,
    disabled: taken.has(c),
  }))
  for (let c = 0; c + 1 < count; c += 2) {
    options.push({
      value: `stereo:${c}`,
      label: count > 2 ? `Stereo ${c + 1}+${c + 2}` : 'Stereo',
      disabled: taken.has(c) || taken.has(c + 1),
    })
  }
  // Inputs the interface doesn't have right now (unplugged, or a smaller one)
  const current = optionValue(list[index])
  if (!options.some((o) => o.value === current)) {
    options.push({ value: current, label: describeInputs(list[index].inputs), disabled: false })
  }
  return options
}

// The list after picking `value` from track `index`'s dropdown
export function applyInputOption(list, index, value) {
  const [kind, raw] = value.split(':')
  const channel = Number(raw)
  const inputs = kind === 'stereo' ? [channel, channel + 1] : [channel]
  return list.map((t, i) => (i === index ? { ...t, inputs } : t))
}

// First input no track uses, or -1 when they're all taken
export function freeInput(list, channelCount) {
  const used = usedByOthers(list, -1)
  for (let c = 0; c < Math.max(1, channelCount); c++) if (!used.has(c)) return c
  return -1
}

// A new track on the free input, or null when there isn't one
export function newInstrument(list, channelCount) {
  const input = freeInput(list, channelCount)
  return input === -1 ? null : { inputs: [input], gain: 1, pan: 0 }
}

// The list without track `index`. The first track always stays.
export function removeTrack(list, index) {
  return index === 0 ? list : list.filter((_, i) => i !== index)
}

// Short description for the lane, e.g. "Input 2" or "Inputs 1+2 (stereo)"
export function describeInputs(inputs) {
  return inputs.length === 2 ? `Inputs ${inputs[0] + 1}+${inputs[1] + 1} (stereo)` : `Input ${inputs[0] + 1}`
}

// A track's channel peaks from the engine's meter message ([0, 0] when absent)
export function trackPeaks(meterTracks, index) {
  const meter = meterTracks.find((t) => t.index === index)
  return meter ? [meter.left, meter.right] : [0, 0]
}
