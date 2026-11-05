// AudioWorklet: real-time pitch shifter (Rubber Band, compiled to WebAssembly by
// rubberband-wasm; GPL). Bundled on its own by Vite (imported with ?worker&url in
// shifter.js). Stereo in, stereo out, at the same rate, pitch × processorOptions.pitch.
//
// Rubber Band works in hops of a few hundred samples, so its output arrives in bursts,
// not a steady 128 per block. Output collects in a FIFO, and playback only starts once
// PRIME_FRAMES have built up, so a gap between bursts never runs it dry.
import { RubberBandInterface, RubberBandOption } from 'rubberband-wasm'

const BLOCK = 128
const CHANNELS = 2
const PRIME_FRAMES = 1024
const FIFO_FRAMES = 16384

class ShifterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { module, pitch } = options.processorOptions
    this.closed = false
    this.primed = false
    this.fifo = Array.from({ length: CHANNELS }, () => new Float32Array(FIFO_FRAMES))
    this.readAt = 0
    this.writeAt = 0
    this.port.onmessage = (event) => {
      if (event.data === 'close') this.closed = true
    }
    RubberBandInterface.initialize(module).then((rb) => {
      // The standard (R2) engine in its "high speed" pitch mode: on a 440 Hz test tone
      // it stayed within −6/+12 cents across 50–125% speed at ~14% of a core, where
      // "high quality" mode drifted up to 34 cents. (R3 was exact but needed 36–90%
      // of a core: too much for the audio thread on an Intel laptop.)
      const options =
        RubberBandOption.RubberBandOptionProcessRealTime |
        RubberBandOption.RubberBandOptionPitchHighSpeed |
        RubberBandOption.RubberBandOptionChannelsTogether
      this.rb = rb
      this.state = rb.rubberband_new(sampleRate, CHANNELS, options, 1, pitch)
      rb.rubberband_set_max_process_size(this.state, BLOCK)
      // float** for process/retrieve: a table of per-channel buffer pointers
      this.inTable = rb.malloc(CHANNELS * 4)
      this.outTable = rb.malloc(CHANNELS * 4)
      this.inBuffers = []
      this.outBuffers = []
      for (let c = 0; c < CHANNELS; c++) {
        const input = rb.malloc(BLOCK * 4)
        const output = rb.malloc(BLOCK * 4)
        rb.memWritePtr(this.inTable + c * 4, input)
        rb.memWritePtr(this.outTable + c * 4, output)
        this.inBuffers.push(input)
        this.outBuffers.push(output)
      }
      this.port.postMessage({ type: 'ready', latency: rb.rubberband_get_latency(this.state) })
    })
  }

  get buffered() {
    return (this.writeAt - this.readAt + FIFO_FRAMES) % FIFO_FRAMES
  }

  // Moves whatever Rubber Band has ready into the FIFO
  drain() {
    const { rb, state } = this
    let available = rb.rubberband_available(state)
    while (available > 0) {
      const frames = Math.min(BLOCK, available)
      const got = rb.rubberband_retrieve(state, this.outTable, frames)
      if (got <= 0) break
      for (let c = 0; c < CHANNELS; c++) {
        const samples = rb.memReadF32(this.outBuffers[c], got)
        for (let i = 0; i < got; i++) this.fifo[c][(this.writeAt + i) % FIFO_FRAMES] = samples[i]
      }
      this.writeAt = (this.writeAt + got) % FIFO_FRAMES
      available -= got
    }
  }

  process(inputs, outputs) {
    if (this.closed) {
      if (this.rb) this.rb.rubberband_delete(this.state)
      return false
    }
    if (!this.rb) return true // still starting: silence

    const input = inputs[0]
    const frames = input?.[0]?.length ?? BLOCK
    for (let c = 0; c < CHANNELS; c++) {
      // Mono in feeds both sides; nothing connected feeds silence
      const samples = input?.[c] ?? input?.[0] ?? new Float32Array(frames)
      this.rb.memWrite(this.inBuffers[c], samples)
    }
    this.rb.rubberband_process(this.state, this.inTable, frames, 0)
    this.drain()

    const output = outputs[0]
    if (!this.primed) {
      if (this.buffered < PRIME_FRAMES) return true
      this.primed = true
    }
    const count = Math.min(output[0].length, this.buffered)
    for (let c = 0; c < output.length; c++) {
      const fifo = this.fifo[Math.min(c, CHANNELS - 1)]
      for (let i = 0; i < count; i++) output[c][i] = fifo[(this.readAt + i) % FIFO_FRAMES]
    }
    this.readAt = (this.readAt + count) % FIFO_FRAMES
    return true
  }
}

registerProcessor('pitch-shifter', ShifterProcessor)
