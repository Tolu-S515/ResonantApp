// Command-line check of the native engine, outside Electron.
//
//   node native/audio-engine/try-engine.mjs list
//   node native/audio-engine/try-engine.mjs monitor <device> [mono|stereo|dual] [seconds] [bufferFrames]
//   node native/audio-engine/try-engine.mjs latency <device> [outputChannel] [inputChannel] [bufferFrames]
//
// <device> is part of the interface's name (or its input uid). Channels are 1-based here, as printed on the interface.
// For `latency`, connect a cable from that output to that input first and turn
// headphones down; monitoring is muted during the test.
import { createRequire } from 'node:module'
import { findInterface, listInterfaces } from './devices.js'

const require = createRequire(import.meta.url)
const audio = require('./build/Release/resonant_audio.node')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dbfs = (value) => (value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dB` : '-inf dB').padStart(9)
const ms = (frames, rate) => `${((frames / rate) * 1000).toFixed(2)} ms`

function startInterface(query, bufferFrames) {
  if (!query) throw new Error('Give part of the interface name. Run "list" to see them.')
  const found = findInterface(audio.listDevices(), query)
  if (!found) throw new Error(`No interface matching "${query}". Run "list" to see them.`)
  const info = audio.start({ inputUid: found.inputUid, outputUid: found.outputUid, bufferFrames: Number(bufferFrames) })
  const split = info.split ? ' (separate input and output devices)' : ''
  console.log(`${info.inputName.trim()}${split}: ${info.sampleRate} Hz, ${info.bufferFrames}-frame buffer, ${info.inputChannels} in / ${info.outputChannels} out`)
  const roundTrip = info.inputLatencyFrames + info.outputLatencyFrames + info.bridgeFrames
  console.log(
    `Reported latency: input ${ms(info.inputLatencyFrames, info.sampleRate)}, output ${ms(info.outputLatencyFrames, info.sampleRate)}` +
      (info.bridgeFrames ? `, bridge ${ms(info.bridgeFrames, info.sampleRate)}` : '') +
      `, round trip ${ms(roundTrip, info.sampleRate)}`,
  )
  return info
}

function printStats() {
  const { underruns, overruns } = audio.stats()
  if (underruns || overruns) console.log(`Bridge: ${underruns} underrun(s), ${overruns} overrun(s) — try a bigger buffer`)
}

const [command = 'list', query, ...rest] = process.argv.slice(2)

if (command === 'list') {
  const interfaces = listInterfaces(audio.listDevices())
  if (interfaces.length === 0) console.log('No audio interface found (needs inputs and outputs). Is it plugged in?')
  for (const i of interfaces) {
    const split = i.split ? ' — shows up as separate input and output devices; paired' : ''
    console.log(`${i.name} — ${i.inputChannels} in / ${i.outputChannels} out, ${i.sampleRate} Hz${split}`)
  }
} else if (command === 'monitor') {
  const [mode = 'mono', seconds = '10', bufferFrames = '64'] = rest
  startInterface(query, bufferFrames)
  if (mode === 'stereo') audio.setTrack(0, { left: 0, right: 1 })
  else if (mode === 'dual') {
    audio.setTrack(0, { left: 0, pan: -0.5 })
    audio.setTrack(1, { left: 1, pan: 0.5 })
  } else audio.setTrack(0, { left: 0 })
  console.log(`Monitoring (${mode}) for ${seconds} s…`)
  const until = Date.now() + Number(seconds) * 1000
  while (Date.now() < until) {
    await sleep(250)
    const tracks = audio.takePeaks().filter((p) => p.index < (mode === 'dual' ? 2 : 1))
    console.log(tracks.map((p) => `track ${p.index + 1}: L ${dbfs(p.left)}  R ${dbfs(p.right)}`).join('   |   '))
  }
  printStats()
  audio.stop()
} else if (command === 'latency') {
  const [outputChannel = '1', inputChannel = '1', bufferFrames = '64'] = rest
  const info = startInterface(query, bufferFrames)
  audio.startLatencyTest({ outputChannel: Number(outputChannel) - 1, inputChannel: Number(inputChannel) - 1 })
  let result
  do {
    await sleep(100)
    result = audio.latencyResult()
  } while (result.state === 'running')
  printStats()
  audio.stop()
  if (result.state !== 'done') {
    console.log(`Test failed after ${result.frames.length} pulse(s): no pulse came back. Check the cable and input gain.`)
    process.exitCode = 1
  } else {
    const sorted = [...result.frames].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    console.log(`Measured round trip: ${median} frames = ${ms(median, info.sampleRate)} (pulses: ${result.frames.join(', ')})`)
  }
} else {
  console.log('Commands: list | monitor <device> [mono|stereo|dual] [seconds] [bufferFrames] | latency <device> [out] [in] [bufferFrames]')
}
