import { closeShifter, createShifter, shifterDelay } from './shifter.js'

// Multitrack playback on a single AudioContext clock.
//
// Each track is a decoded AudioBuffer → its own GainNode → music bus → master → speakers.
// The click track skips the music bus (see MUSIC_BUS_DB).
// On play, every track gets a fresh AudioBufferSourceNode and all of them are
// started at the same context time, so they stay sample-aligned.
// (Source nodes are one-shot: pause stops them, play/seek makes new ones.)
//
// Speed (setSpeed), in real time: every song track plays at the same playbackRate,
// like a slowed tape, so they stay sample-locked; one pitch shifter on the music bus
// then undoes the pitch change. The shifter runs a few tens of ms behind, so the
// click (built for the new tempo, not shifted) goes through a matching delay, and
// position() allows for it. Positions in and out are always in song time: at 80% a
// 100 s song takes 125 s to play, and position() still runs 0 → 100.
//
// Key changes are offline renders, swapped in with swapBuffers.

// Small lead so every source is scheduled before its start time arrives
const START_DELAY = 0.03
// Time constant for gain changes; short enough to feel instant, long enough not to click
const GAIN_SMOOTHING = 0.01
// Longest shifter delay the click can be held back to match
const MAX_CLICK_DELAY = 1

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

  // The click waits as long as the shifter takes, so they stay together
  const clickDelay = ctx.createDelay(MAX_CLICK_DELAY)
  clickDelay.connect(master)
  let shifter = null // pitch shifter node while speed ≠ 1
  let shifterLag = 0 // seconds the music runs behind with the shifter in
  let speedRequest = 0

  const tracks = new Map() // id → { buffer, gain, source }
  const loads = new Map() // id → load promise, so each track is fetched once
  let playing = false
  let startedAt = 0 // context time at which playback started from `offset`
  let offset = 0 // song time playback started from (or is paused at)
  let duration = 0 // song length (seconds)
  let speed = 1
  // Bumped by swapBuffers, so an original track that finishes loading afterwards
  // doesn't replace its key-changed version
  let generation = 0

  function track(id) {
    let t = tracks.get(id)
    if (!t) {
      const gain = ctx.createGain()
      gain.connect(id === clickTrackId ? clickDelay : musicBus)
      t = { buffer: null, gain, source: null }
      tracks.set(id, t)
    }
    return t
  }

  // Starts a track's source at context time `when`, from song time `at`. Song tracks
  // play at `speed`; the click's buffer is already at the new tempo, so it plays at
  // normal rate from the matching point.
  function startSource(t, when, at) {
    const isClick = t === tracks.get(clickTrackId)
    const bufferAt = isClick ? at / speed : at
    if (!t.buffer || bufferAt >= t.buffer.duration) return
    const source = ctx.createBufferSource()
    source.buffer = t.buffer
    source.playbackRate.value = isClick ? 1 : speed
    source.connect(t.gain)
    source.start(when, bufferAt)
    t.source = source
  }

  function startSources(at) {
    const when = ctx.currentTime + START_DELAY
    startedAt = when
    offset = at
    for (const t of tracks.values()) startSource(t, when, at)
  }

  // Song time a source started at context time `when` should start from
  const songTimeAt = (when) => offset + (when - startedAt) * speed

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
    // Song length, in song time
    get duration() {
      return duration
    },
    // Fetches and decodes a track. Calling it again for the same id reuses the first load.
    // A track that finishes loading during playback joins in, aligned to the others.
    load(id, url) {
      if (!loads.has(id)) {
        const startedGeneration = generation
        const promise = (async () => {
          const buffer = await this.decode(url, id)
          if (generation !== startedGeneration) return
          const t = track(id)
          t.buffer = buffer
          duration = Math.max(duration, buffer.duration)
          if (playing) {
            const when = ctx.currentTime + START_DELAY
            startSource(t, when, songTimeAt(when))
          }
        })()
        // Allow a retry after a failure
        promise.catch(() => loads.delete(id))
        loads.set(id, promise)
      }
      return loads.get(id)
    },

    // Fetches and decodes an audio file without playing it
    async decode(url, label = url) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Could not load ${label} (${response.status})`)
      return ctx.decodeAudioData(await response.arrayBuffer())
    },

    // Song time currently coming out of the speakers. Subtracting the output latency
    // (and the shifter's lag) keeps the playhead with what you hear, not what's scheduled.
    position() {
      if (!playing) return offset
      const elapsed = ctx.currentTime - (ctx.outputLatency || 0) - shifterLag - startedAt
      return clamp(offset + Math.max(0, elapsed) * speed)
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
        startSource(t, when, songTimeAt(when))
      }
    },

    // Replaces the song tracks all at once (buffers: Map of id → AudioBuffer), e.g.
    // with a key-changed version, or back to the originals. Playback carries on from
    // the same song position.
    swapBuffers(buffers) {
      const at = this.position()
      if (playing) stopSources()
      generation++
      for (const [id, buffer] of buffers) track(id).buffer = buffer
      duration = Math.max(0, ...[...tracks].filter(([id]) => id !== clickTrackId).map(([, t]) => t.buffer?.duration ?? 0))
      offset = clamp(at)
      if (playing) startSources(offset)
    },

    // Plays at `next` × speed (1 = normal) without changing the pitch. Takes effect
    // straight away, mid-song included, from the same song position. The click is
    // cleared, since it has to be rebuilt for the new tempo: set it again with setBuffer
    // (built with each beat at time / speed). Resolves true once applied, or false if
    // a later call replaced it.
    async setSpeed(next) {
      const request = ++speedRequest
      let node = null
      let lag = 0
      if (next !== 1) [node, lag] = await Promise.all([createShifter(ctx, 1 / next), shifterDelay(next, ctx.sampleRate)])
      if (request !== speedRequest) {
        if (node) closeShifter(node)
        return false
      }
      const at = this.position()
      if (playing) stopSources()
      musicBus.disconnect()
      if (shifter) closeShifter(shifter)
      shifter = node
      if (shifter) {
        musicBus.connect(shifter)
        shifter.connect(master)
      } else {
        musicBus.connect(master)
      }
      speed = next
      shifterLag = lag
      clickDelay.delayTime.setValueAtTime(lag, ctx.currentTime)
      const click = tracks.get(clickTrackId)
      if (click) click.buffer = null
      offset = clamp(at)
      if (playing) startSources(offset)
      return true
    },

    get speed() {
      return speed
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
