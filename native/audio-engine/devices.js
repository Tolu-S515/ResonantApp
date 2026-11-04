// Turns CoreAudio's device list into audio interfaces: an input device plus
// the output device to monitor on.
//
// Most interfaces are one device with inputs and outputs. Some budget USB ones
// (e.g. Burr-Brown "USB AUDIO  CODEC") appear as two devices, an input-only and
// an output-only one with the same name. Those halves are paired here.

// The uid without its trailing ":<n>", which is all that differs between the halves
const uidBase = (uid) => uid.replace(/:\d+$/, '')

// The output half that belongs to an input-only device, or undefined
function partnerOf(input, devices) {
  const outputs = devices.filter((d) => d.outputChannels > 0 && d.inputChannels === 0)
  return (
    (input.clockDomain && outputs.find((d) => d.clockDomain === input.clockDomain)) ||
    outputs.find((d) => uidBase(d.uid) === uidBase(input.uid)) ||
    outputs.find((d) => d.name === input.name)
  )
}

// [{ name, inputUid, outputUid, inputChannels, outputChannels, sampleRate, split }]
// Only devices you can both play into and monitor from. The Mac's built-in mic
// and speakers are separate parts with separate clocks, so they never pair.
export function listInterfaces(devices) {
  const interfaces = []
  for (const input of devices) {
    if (input.inputChannels === 0) continue
    const output = input.outputChannels > 0 ? input : partnerOf(input, devices)
    if (!output || output.uid.startsWith('BuiltIn')) continue
    interfaces.push({
      name: input.name.trim(),
      inputUid: input.uid,
      outputUid: output.uid,
      inputChannels: input.inputChannels,
      outputChannels: output.outputChannels,
      sampleRate: input.sampleRate,
      split: output !== input,
    })
  }
  return interfaces
}

// The interface whose input uid is `query`, or whose name contains it (any case)
export function findInterface(devices, query) {
  const interfaces = listInterfaces(devices)
  const lower = query.toLowerCase()
  return interfaces.find((i) => i.inputUid === query) ?? interfaces.find((i) => i.name.toLowerCase().includes(lower))
}
