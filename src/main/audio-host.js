// Runs in an Electron utility process and hosts the native audio engine, so a
// crash in native code takes down only this process, not the app.
//
// Messages from main: { id, method, args } → replies { type: 'reply', id, result | error }.
// While audio runs it also sends { type: 'meters', tracks, inputs } about 30 times a second.
import { createRequire } from 'node:module'

const METER_INTERVAL_MS = 33

const engine = createRequire(__filename)(process.env.RESONANT_AUDIO_ADDON)
const post = (message) => process.parentPort.postMessage(message)

let meterTimer = null
function stopMeters() {
  clearInterval(meterTimer)
  meterTimer = null
}

const methods = {
  listDevices: () => engine.listDevices(),
  start: (options) => {
    const info = engine.start(options)
    stopMeters()
    meterTimer = setInterval(
      () => post({ type: 'meters', tracks: engine.takePeaks(), inputs: engine.takeInputPeaks() }),
      METER_INTERVAL_MS,
    )
    return info
  },
  stop: () => {
    stopMeters()
    engine.stop()
  },
  info: () => engine.info(),
  stats: () => engine.stats(),
  setTrack: (index, settings) => engine.setTrack(index, settings),
  clearTrack: (index) => engine.clearTrack(index),
  startLatencyTest: (options) => engine.startLatencyTest(options),
  latencyResult: () => engine.latencyResult(),
  startRecording: (options) => engine.startRecording(options),
  stopRecording: () => engine.stopRecording(),
  recordingStatus: () => engine.recordingStatus(),
}

process.parentPort.on('message', ({ data }) => {
  const { id, method, args = [] } = data
  try {
    if (!Object.hasOwn(methods, method)) throw new Error(`Unknown audio method: ${method}`)
    post({ type: 'reply', id, result: methods[method](...args) ?? null })
  } catch (err) {
    post({ type: 'reply', id, error: err.message })
  }
})
