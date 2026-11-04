// Main-process side of the native audio engine (see audio-host.js).
import { listInterfaces } from '../../native/audio-engine/devices.js'

// Talks to the engine's utility process. `fork` creates it; it's started on the
// first call and again after a crash.
// onMessage gets everything that isn't a reply (meters); onExit(crashed) when it goes away.
export function createAudioHost({ fork, onMessage, onExit }) {
  let child = null
  let stopping = false
  let nextId = 1
  const pending = new Map()

  function spawn() {
    const proc = fork()
    proc.on('message', (message) => {
      if (message.type !== 'reply') return onMessage?.(message)
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      if (message.error) call.reject(new Error(message.error))
      else call.resolve(message.result)
    })
    proc.on('exit', () => {
      if (child === proc) child = null
      for (const call of pending.values()) call.reject(new Error('The audio engine stopped unexpectedly'))
      pending.clear()
      onExit?.(!stopping)
      stopping = false
    })
    return proc
  }

  return {
    call(method, ...args) {
      child ??= spawn()
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.postMessage({ id, method, args })
      })
    },
    kill() {
      if (!child) return
      stopping = true
      child.kill()
    },
  }
}

// Keeps the engine running whenever the chosen interface is connected, with the
// instrument tracks applied, so it can be restored after a device change or a crash.
// Pushes state to the page.
//
// host: from createAudioHost. readAudio/saveAudio: the 'audio' settings section.
// ensureMicAccess: resolves, or throws if macOS denies input. send(channel, data): to the page.
// now: clock (for crash-loop protection).
export function createAudioController({ host, readAudio, saveAudio, ensureMicAccess, send, now = Date.now }) {
  let info = null // engine info while running
  let error = null // why audio isn't running, if it should be
  let lastCrash = -Infinity
  const tracks = new Map() // index → settings

  // Device changes, interface picks and crash recovery run one at a time
  let queue = Promise.resolve()
  const serial = (job) => {
    const result = queue.then(job)
    queue = result.catch(() => {})
    return result
  }

  async function state() {
    return { settings: await readAudio(), info, error }
  }

  async function pushState() {
    send('audio:state', await state())
  }

  async function stopEngine() {
    if (!info) return
    info = null
    try {
      await host.call('stop')
    } catch {
      // Already gone (unplugged or crashed): nothing left to stop
    }
  }

  // Starts the engine if the chosen interface is connected, stops it if it isn't
  async function sync() {
    const settings = await readAudio()
    if (!settings.inputUid || !settings.outputUid) {
      await stopEngine()
      error = null
      return
    }
    try {
      const devices = await host.call('listDevices')
      const found = listInterfaces(devices).some(
        (i) => i.inputUid === settings.inputUid && i.outputUid === settings.outputUid,
      )
      if (!found) {
        await stopEngine()
        error = `${settings.name?.trim() || 'The audio interface'} isn't connected`
        return
      }
      if (info) return
      await ensureMicAccess()
      info = await host.call('start', {
        inputUid: settings.inputUid,
        outputUid: settings.outputUid,
        bufferFrames: settings.bufferFrames,
      })
      error = null
      for (const [index, track] of tracks) await host.call('setTrack', index, track)
    } catch (err) {
      info = null
      error = err.message
    }
  }

  return {
    state,

    async listInterfaces() {
      return listInterfaces(await host.call('listDevices'))
    },

    // Brings the engine in line with the hardware: call at launch and whenever
    // devices change. Problems end up in state().error rather than throwing.
    connect: () =>
      serial(async () => {
        await sync()
        await pushState()
        return state()
      }),

    // Saves the interface/buffer, then reconnects with it
    setDevice: (changes) =>
      serial(async () => {
        await saveAudio(changes)
        await stopEngine()
        await sync()
        await pushState()
        return state()
      }),

    async setTrack(index, settings) {
      tracks.set(index, settings)
      if (info) await host.call('setTrack', index, settings)
    },

    async clearTrack(index) {
      tracks.delete(index)
      if (info) await host.call('clearTrack', index)
    },

    // From the host: meters while running
    handleMessage(message) {
      if (message.type === 'meters') send('audio:meters', { tracks: message.tracks, inputs: message.inputs })
    },

    // From the host: the utility process went away. Restarts it, unless it
    // crashed moments ago too (then waits for the next connect, e.g. a device change).
    handleExit(crashed) {
      if (!crashed || !info) return
      info = null
      const recent = now() - lastCrash < 10_000
      lastCrash = now()
      if (recent) {
        error = 'The audio engine keeps stopping unexpectedly. Try another buffer size, or reconnect the interface.'
        pushState()
        return
      }
      serial(async () => {
        await sync()
        await pushState()
      })
    },
  }
}
