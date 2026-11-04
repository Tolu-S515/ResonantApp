import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createAudioController, createAudioHost } from './audio.js'

// A pretend utility process: answers calls with `respond`, and can crash
function fakeProcess(respond) {
  const proc = new EventEmitter()
  proc.postMessage = ({ id, method, args }) => {
    queueMicrotask(() => {
      try {
        proc.emit('message', { type: 'reply', id, result: respond(method, ...args) ?? null })
      } catch (err) {
        proc.emit('message', { type: 'reply', id, error: err.message })
      }
    })
  }
  proc.kill = () => queueMicrotask(() => proc.emit('exit', 0))
  proc.crash = () => proc.emit('exit', 1)
  return proc
}

const codecIn = { uid: 'codec:2', name: 'USB AUDIO  CODEC', inputChannels: 2, outputChannels: 0, sampleRate: 44100, clockDomain: 0 }
const codecOut = { uid: 'codec:1', name: 'USB AUDIO  CODEC', inputChannels: 0, outputChannels: 2, sampleRate: 44100, clockDomain: 0 }
const info = { inputUid: 'codec:2', outputUid: 'codec:1', split: true, sampleRate: 44100, bufferFrames: 64 }

function setup({ micDenied = false, devices: initialDevices = [codecIn, codecOut], audio = { inputUid: 'codec:2', outputUid: 'codec:1', name: 'USB AUDIO  CODEC', bufferFrames: 64 } } = {}) {
  const calls = []
  const procs = []
  let devices = initialDevices
  let clock = 0
  const respond = (method, ...args) => {
    calls.push([method, ...args])
    if (method === 'listDevices') return devices
    if (method === 'start') return info
  }
  let settings = { ...audio }
  const sent = []
  let controller
  const host = createAudioHost({
    fork: () => {
      const proc = fakeProcess(respond)
      procs.push(proc)
      return proc
    },
    onMessage: (message) => controller.handleMessage(message),
    onExit: (crashed) => controller.handleExit(crashed),
  })
  controller = createAudioController({
    host,
    readAudio: async () => settings,
    saveAudio: async (changes) => {
      settings = { ...settings, ...changes }
    },
    ensureMicAccess: async () => {
      if (micDenied) throw new Error('Microphone access denied')
    },
    send: (channel, data) => sent.push([channel, data]),
    now: () => clock,
  })
  return {
    controller,
    calls,
    procs,
    sent,
    host,
    setDevices: (next) => (devices = next),
    advance: (ms) => (clock += ms),
  }
}

describe('createAudioHost', () => {
  it('rejects pending calls when the process crashes, then starts a new one', async () => {
    let proc
    const host = createAudioHost({
      fork: () => {
        proc = fakeProcess(() => 'ok')
        proc.postMessage = () => {} // never answers
        return proc
      },
    })
    const call = host.call('info')
    proc.crash()
    await expect(call).rejects.toThrow('stopped unexpectedly')
    const first = proc
    host.call('info')
    expect(proc).not.toBe(first)
  })

  it('turns engine errors into rejections', async () => {
    const host = createAudioHost({
      fork: () =>
        fakeProcess(() => {
          throw new Error('Audio device not found')
        }),
    })
    await expect(host.call('start', {})).rejects.toThrow('Audio device not found')
  })
})

describe('createAudioController', () => {
  const track = { left: 0, right: -1, gain: 1, pan: 0, monitor: true }
  const methods = (calls) => calls.map(([m]) => m)

  it('starts the saved interface with its buffer size', async () => {
    const { controller, calls } = setup()
    const state = await controller.connect()
    expect(calls).toContainEqual(['start', { inputUid: 'codec:2', outputUid: 'codec:1', bufferFrames: 64 }])
    expect(state.info).toEqual(info)
    expect(state.error).toBeNull()
  })

  it('does nothing until an interface is chosen', async () => {
    const { controller, calls } = setup({ audio: { inputUid: null, outputUid: null, name: null, bufferFrames: 64 } })
    const state = await controller.connect()
    expect(calls).toEqual([])
    expect(state).toMatchObject({ info: null, error: null })
  })

  it('says so when the interface is unplugged, and starts once it is plugged in', async () => {
    const { controller, sent, setDevices } = setup({ devices: [] })
    expect(await controller.connect()).toMatchObject({ info: null, error: "USB AUDIO  CODEC isn't connected" })
    expect(sent.at(-1)[1].error).toMatch(/isn't connected/)

    setDevices([codecIn, codecOut])
    expect(await controller.connect()).toMatchObject({ info, error: null })
  })

  it('stops when the interface is unplugged while running', async () => {
    const { controller, calls, setDevices } = setup()
    await controller.connect()
    setDevices([])
    calls.length = 0
    expect(await controller.connect()).toMatchObject({ info: null, error: expect.stringMatching(/isn't connected/) })
    expect(methods(calls)).toEqual(['listDevices', 'stop'])
  })

  it('leaves a running engine alone on other device changes', async () => {
    const { controller, calls } = setup()
    await controller.connect()
    calls.length = 0
    await controller.connect()
    expect(methods(calls)).toEqual(['listDevices'])
  })

  it('applies tracks set before and after starting', async () => {
    const { controller, calls } = setup()
    await controller.setTrack(0, track)
    expect(calls.some(([m]) => m === 'setTrack')).toBe(false) // not running yet, nothing to tell the engine
    await controller.connect()
    await controller.setTrack(1, { ...track, left: 1 })
    expect(calls.filter(([m]) => m === 'setTrack')).toEqual([
      ['setTrack', 0, track],
      ['setTrack', 1, { ...track, left: 1 }],
    ])
  })

  it('restarts on a new buffer size, keeping the tracks', async () => {
    const { controller, calls } = setup()
    await controller.setTrack(0, { ...track, right: 1 })
    await controller.connect()
    calls.length = 0
    await controller.setDevice({ bufferFrames: 128 })
    expect(methods(calls)).toEqual(['stop', 'listDevices', 'start', 'setTrack'])
    expect(calls[2][1].bufferFrames).toBe(128)
  })

  it('starts as soon as an interface is chosen', async () => {
    const { controller, calls } = setup({ audio: { inputUid: null, outputUid: null, name: null, bufferFrames: 64 } })
    const state = await controller.setDevice({ inputUid: 'codec:2', outputUid: 'codec:1', name: 'USB AUDIO  CODEC' })
    expect(methods(calls)).toEqual(['listDevices', 'start'])
    expect(state.info).toEqual(info)
  })

  it('runs overlapping requests one at a time', async () => {
    const { controller, calls } = setup()
    await Promise.all([controller.connect(), controller.connect(), controller.setDevice({ bufferFrames: 128 })])
    expect(methods(calls)).toEqual(['listDevices', 'start', 'listDevices', 'stop', 'listDevices', 'start'])
  })

  it('shows a start failure instead of throwing', async () => {
    const { controller, calls } = setup({ micDenied: true })
    expect(await controller.connect()).toMatchObject({ info: null, error: 'Microphone access denied' })
    expect(methods(calls)).not.toContain('start')
  })

  it('restarts by itself after a crash, with its tracks', async () => {
    const { controller, procs, sent, calls } = setup()
    await controller.setTrack(0, track)
    await controller.connect()
    calls.length = 0
    procs[0].crash()
    await vi.waitFor(() => expect(methods(calls)).toEqual(['listDevices', 'start', 'setTrack']))
    expect(procs).toHaveLength(2)
    await vi.waitFor(() => expect(sent.at(-1)[1]).toMatchObject({ info, error: null }))
  })

  it('stops retrying if it crashes again straight away', async () => {
    const { controller, procs, sent, advance } = setup()
    await controller.connect()
    procs[0].crash()
    await vi.waitFor(() => expect(procs).toHaveLength(2))
    await vi.waitFor(async () => expect((await controller.state()).info).toEqual(info))
    advance(2000)
    procs[1].crash()
    await vi.waitFor(() => expect(sent.at(-1)[1].error).toMatch(/keeps stopping/))
    expect(procs).toHaveLength(2)
    expect(sent.at(-1)[1].info).toBeNull()
  })

  it('forwards meters to the page', () => {
    const { controller, sent } = setup()
    controller.handleMessage({ type: 'meters', tracks: [{ index: 0, left: 0.5, right: 0.5 }], inputs: [0.5, 0] })
    expect(sent).toEqual([['audio:meters', { tracks: [{ index: 0, left: 0.5, right: 0.5 }], inputs: [0.5, 0] }]])
  })
})
