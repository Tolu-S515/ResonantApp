// Multitrack playback on a single AudioContext clock.
//
// Each track is a decoded AudioBuffer → its own GainNode → music bus → master → speakers.
// The click track skips the music bus (see MUSIC_BUS_DB).
// On play, every track gets a fresh AudioBufferSourceNode and all of them are
// started at the same context time, so they stay sample-aligned.
// (Source nodes are one-shot: pause stops them, play/seek makes new ones.)

// Small lead so every source is scheduled before its start time arrives
const START_DELAY = 0.03
// Time constant for gain changes; short enough to feel instant, long enough not to click
const GAIN_SMOOTHING = 0.01

// The song is mastered to 0 dBFS, which leaves no room above it for the click.
// Turning all song tracks down by this much gives the click real headroom: boosting
// it then makes it louder instead of just pushing it into the limiter.
export const MUSIC_BUS_DB = -6

// clickTrackId: the track that bypasses the music bus (the metronome)
export function createEngine({ clickTrackId = 'metronome' } = {}) {
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  const master = ctx.createGain()

  // Safety limiter: stems plus a loud click can exceed full scale, and the
  // output hard-clips (audible crackle). This only acts on peaks above -1 dBFS.
  // Its small look-ahead delays every track equally, so sync is unaffected.
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -1
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.1
  master.connect(limiter)

  const musicBus = ctx.createGain()
  musicBus.gain.value = 10 ** (MUSIC_BUS_DB / 20)
  musicBus.connect(master)
  limiter.connect(ctx.destination)

  const tracks = new Map() // id → { buffer, gain, source }
  const loads = new Map() // id → load promise, so each track is fetched once
  let playing = false
  let startedAt = 0 // context time at which song time 0 would have played
  let offset = 0 // song time while paused
  let duration = 0

  function track(id) {
    let t = tracks.get(id)
    if (!t) {
      const gain = ctx.createGain()
      gain.connect(id === clickTrackId ? master : musicBus)
      t = { buffer: null, gain, source: null }
      tracks.set(id, t)
    }
    return t
  }

  function startSource(t, when, at) {
    if (!t.buffer || at >= t.buffer.duration) return
    const source = ctx.createBufferSource()
    source.buffer = t.buffer
    source.connect(t.gain)
    source.start(when, at)
    t.source = source
  }

  function startSources(at) {
    const when = ctx.currentTime + START_DELAY
    startedAt = when - at
    for (const t of tracks.values()) startSource(t, when, at)
  }

  function stopSources() {
    for (const t of tracks.values()) {
      if (!t.source) continue
      t.source.stop()
      t.source.disconnect()
      t.source = null
    }
  }

  const clamp = (time) => Math.min(Math.max(time, 0), duration)

  return {
    get playing() {
      return playing
    },
    get duration() {
      return duration
    },

    // Fetches and decodes a track. Calling it again for the same id reuses the first load.
    // A track that finishes loading during playback joins in, aligned to the others.
    load(id, url) {
      if (!loads.has(id)) {
        const promise = (async () => {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`Could not load ${id} (${response.status})`)
          const buffer = await ctx.decodeAudioData(await response.arrayBuffer())
          const t = track(id)
          t.buffer = buffer
          duration = Math.max(duration, buffer.duration)
          if (playing) {
            const when = ctx.currentTime + START_DELAY
            startSource(t, when, when - startedAt)
          }
        })()
        // Allow a retry after a failure
        promise.catch(() => loads.delete(id))
        loads.set(id, promise)
      }
      return loads.get(id)
    },

    // Song time currently coming out of the speakers. Subtracting outputLatency
    // keeps the playhead in line with what you hear, not what's been scheduled.
    position() {
      if (!playing) return offset
      return clamp(ctx.currentTime - (ctx.outputLatency || 0) - startedAt)
    },

    play() {
      if (playing || duration === 0) return
      ctx.resume()
      if (offset >= duration) offset = 0
      startSources(offset)
      playing = true
    },

    pause() {
      if (!playing) return
      offset = this.position()
      stopSources()
      playing = false
    },

    seek(time) {
      offset = clamp(time)
      if (playing) {
        stopSources()
        startSources(offset)
      }
    },

    // Puts an already-built buffer on a track (the click track), replacing any
    // previous one. Mid-playback, the new buffer takes over at the current position.
    // Doesn't change the song's duration.
    setBuffer(id, buffer) {
      const t = track(id)
      if (t.source) {
        t.source.stop()
        t.source.disconnect()
        t.source = null
      }
      t.buffer = buffer
      if (playing) {
        const when = ctx.currentTime + START_DELAY
        startSource(t, when, when - startedAt)
      }
    },

    setGain(id, value) {
      track(id).gain.gain.setTargetAtTime(value, ctx.currentTime, GAIN_SMOOTHING)
    },

    // Level of everything this engine plays (song tracks and click), before the
    // limiter. Turning it down leaves room for the live instrument on top.
    setBackingLevel(value) {
      master.gain.setTargetAtTime(value, ctx.currentTime, GAIN_SMOOTHING)
    },

    // Plays through this output device ('' = the system default). Ids come from
    // navigator.mediaDevices.enumerateDevices(); see output.js. Safe mid-playback.
    setOutputDevice(deviceId) {
      if (ctx.sinkId === deviceId) return Promise.resolve()
      return ctx.setSinkId(deviceId)
    },

    close() {
      stopSources()
      playing = false
      return ctx.close()
    },
  }
}
