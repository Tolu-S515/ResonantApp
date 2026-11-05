// Real-time pitch shifter (Rubber Band compiled to WebAssembly by rubberband-wasm;
// GPL), used to undo the pitch drop of playing the stems slower (and the rise of
// faster). The processing runs in an AudioWorklet: see shifter-processor.js.
import wasmUrl from 'rubberband-wasm/dist/rubberband.wasm?url'
import processorUrl from './shifter-processor.js?worker&url'

const PROCESSOR = 'pitch-shifter'
const CACHE_KEY = 'resonant.shifterDelay.v3' // bump when the shifter's settings change

const processors = new WeakMap() // context → addModule promise
let wasmModule = null

function loadProcessor(ctx) {
  if (!processors.has(ctx)) processors.set(ctx, ctx.audioWorklet.addModule(processorUrl))
  return processors.get(ctx)
}

// Compiled once and handed to every worklet. (Not compileStreaming: a file:// fetch
// in the packaged app has no application/wasm type.)
function loadWasm() {
  wasmModule ??= fetch(wasmUrl)
    .then((response) => response.arrayBuffer())
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((err) => {
      wasmModule = null
      throw err
    })
  return wasmModule
}

// A pitch shifter node, ready to connect: stereo in, stereo out, pitch × ratio.
// `ready` resolves once Rubber Band is running inside it (until then it's silent).
export async function createShifter(ctx, ratio) {
  const [module] = await Promise.all([loadWasm(), loadProcessor(ctx)])
  const node = new AudioWorkletNode(ctx, PROCESSOR, {
    outputChannelCount: [2],
    processorOptions: { module, pitch: ratio },
  })
  node.ready = new Promise((resolve) => {
    node.port.onmessage = (event) => event.data?.type === 'ready' && resolve()
  })
  return node
}

// Stops a shifter's processing for good (and disconnects it)
export function closeShifter(node) {
  node.port.postMessage('close')
  node.disconnect()
}

// For each burst at song time t (played at `speed`, so it should come out at t / speed),
// how much later it actually came out, in seconds. Pure, for testing.
export function burstDelays(samples, sampleRate, bursts, speed, threshold = 0.1) {
  return bursts.map((t) => {
    const expected = t / speed
    let i = Math.max(0, Math.round((expected - 0.05) * sampleRate))
    while (i < samples.length && Math.abs(samples[i]) < threshold) i++
    return i / sampleRate - expected
  })
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// How far behind its input the shifter's output runs at this speed (seconds). It
// depends on the speed (roughly 50–60 ms at 44.1 kHz), so it's measured once per speed
// and sample rate by playing timed bursts through it offline, then remembered on this
// computer.
const delays = new Map()

export function shifterDelay(speed, sampleRate) {
  const key = `${sampleRate}:${speed}`
  if (!delays.has(key)) {
    const saved = readCache()[key]
    const promise = typeof saved === 'number' ? Promise.resolve(saved) : measureDelay(speed, sampleRate)
    promise.then((delay) => writeCache(key, delay)).catch(() => delays.delete(key))
    delays.set(key, promise)
  }
  return delays.get(key)
}

async function measureDelay(speed, sampleRate) {
  const songSeconds = 3
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * (songSeconds / speed + 0.5)), sampleRate)
  const shifter = await createShifter(ctx, 1 / speed)

  // 10 ms bursts of 1 kHz every half second of song time
  const bursts = []
  for (let t = 0.5; t < songSeconds - 0.2; t += 0.5) bursts.push(t)
  const input = new AudioBuffer({ length: sampleRate * songSeconds, sampleRate, numberOfChannels: 2 })
  for (let ch = 0; ch < 2; ch++) {
    const data = input.getChannelData(ch)
    for (const t of bursts) {
      const start = Math.round(t * sampleRate)
      for (let i = 0; i < sampleRate * 0.01; i++) data[start + i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate)
    }
  }
  const source = new AudioBufferSourceNode(ctx, { buffer: input, playbackRate: speed })
  source.connect(shifter)
  shifter.connect(ctx.destination)
  source.start(0)
  // Hold the render at the start until Rubber Band is running in the worklet
  ctx.suspend(128 / sampleRate).then(() => shifter.ready.then(() => ctx.resume()))
  const output = await ctx.startRendering()
  const delay = median(burstDelays(output.getChannelData(0), sampleRate, bursts, speed))
  if (!(delay > 0 && delay < 0.5)) throw new Error('Could not measure the speed change delay')
  return delay
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? {}
  } catch {
    return {}
  }
}

function writeCache(key, delay) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), [key]: delay }))
  } catch {
    // Measured again next time
  }
}
