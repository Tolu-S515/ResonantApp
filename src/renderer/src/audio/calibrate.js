// Recording calibration with a loopback cable (output 1 → an input): plays a few
// clicks out of the interface while the engine records that input, then main finds
// them and saves how far off the recording was. See shared/recording.js.
import { epochOffset } from './clock.js'
import { createLimiter } from './engine.js'
import { findOutputDevice } from './output.js'

const PULSES = 6
const PULSE_GAP = 0.4 // seconds
const PULSE_FRAMES = 16
const PULSE_LEVEL = 0.5
const LEAD_IN = 0.5 // seconds after recording starts before the first click
const TAIL = 0.6 // seconds after the last click before stopping

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Resolves { offsetMs, heard } (saved by main), or rejects with what went wrong
export async function calibrateRecording({ interfaceName, inputChannel }) {
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  let started = false
  try {
    const deviceId = await findOutputDevice(interfaceName)
    if (!deviceId) throw new Error("Couldn't find the interface's output")
    await ctx.setSinkId(deviceId)
    await ctx.resume()

    // Same path to the speakers as playback (the limiter delays it a little)
    const limiter = createLimiter(ctx)
    limiter.connect(ctx.destination)
    const pulse = ctx.createBuffer(1, PULSE_FRAMES, ctx.sampleRate)
    pulse.getChannelData(0).fill(PULSE_LEVEL)

    await window.resonant.recording.startCalibration(inputChannel)
    started = true
    const first = ctx.currentTime + LEAD_IN
    const times = Array.from({ length: PULSES }, (_, i) => first + i * PULSE_GAP)
    for (const time of times) {
      const source = ctx.createBufferSource()
      source.buffer = pulse
      source.connect(limiter)
      source.start(time)
    }
    await wait((LEAD_IN + PULSES * PULSE_GAP + TAIL) * 1000)

    // When each click came out of the speakers, on the wall clock
    const { contextTime, performanceTime } = ctx.getOutputTimestamp()
    const offset = epochOffset()
    const expectedMs = times.map((time) => performanceTime + (time - contextTime) * 1000 + offset)
    started = false
    return await window.resonant.recording.finishCalibration(expectedMs)
  } finally {
    if (started) await window.resonant.recording.finishCalibration([]).catch(() => {})
    ctx.close()
  }
}
