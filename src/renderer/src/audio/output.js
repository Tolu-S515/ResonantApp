// Finds the audio interface among Web Audio's output devices, so backing
// tracks play out of the same interface (and the same clock) as monitoring.
//
// Web Audio and CoreAudio don't share device ids, so this matches on the name:
// Chromium's label is the CoreAudio name, sometimes with extra detail added
// (e.g. "USB AUDIO  CODEC (08bb:2902)").

const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase()

// deviceId of the output whose label contains `name`, or null
export function matchOutputDevice(devices, name) {
  if (!name) return null
  const target = normalize(name)
  const match = devices.find(
    (d) =>
      d.kind === 'audiooutput' &&
      d.deviceId !== 'default' &&
      d.deviceId !== 'communications' &&
      normalize(d.label).includes(target),
  )
  return match?.deviceId ?? null
}

export async function findOutputDevice(name) {
  return matchOutputDevice(await navigator.mediaDevices.enumerateDevices(), name)
}
