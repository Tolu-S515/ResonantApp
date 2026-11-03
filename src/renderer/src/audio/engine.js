// Multitrack playback on a single AudioContext clock.
//
// Each track is a decoded AudioBuffer → its own GainNode → master → speakers.
// On play, every track gets a fresh AudioBufferSourceNode and all of them are
// started at the same context time, so they stay sample-aligned.
// (Source nodes are one-shot: pause stops them, play/seek makes new ones.)

// Small lead so every source is scheduled before its start time arrives
const START_DELAY = 0.03
// Time constant for gain changes; short enough to feel instant, long enough not to click
const GAIN_SMOOTHING = 0.01

export function createEngine() {
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  const master = ctx.createGain()
  master.connect(ctx.destination)

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
      gain.connect(master)
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

    setGain(id, value) {
      track(id).gain.gain.setTargetAtTime(value, ctx.currentTime, GAIN_SMOOTHING)
    },

    close() {
      stopSources()
      playing = false
      return ctx.close()
    },
  }
}
