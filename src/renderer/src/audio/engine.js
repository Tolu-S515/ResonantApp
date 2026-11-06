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
//
// Looping (setLoop): playback runs in segments, each a stretch of song from a start
// point. At the loop end, every source stops and a fresh set starts from the loop
// start at that same context time, so the wrap is sample-exact for every track. The
// next segment is set up a little ahead of the wrap, which leaves time to move or
// switch off the loop before it.
//
// Clips (recorded takes, setClip) are tracks that start at a song time instead of 0.
// They have their own bus: the backing level (setBackingLevel) leaves them alone,
// since they're your instrument, but they go through the shifter like the song.
//
//   song tracks → music bus → backing level ─┐
//   clips ──────→ clip bus ──────────────────┴→ [shifter] → limiter → speakers
//   click ──────→ click delay → backing level ───────────────↗

// Small lead so every source is scheduled before its start time arrives
const START_DELAY = 0.03
// Time constant for gain changes; short enough to feel instant, long enough not to click
const GAIN_SMOOTHING = 0.01
// Longest shifter delay the click can be held back to match
const MAX_CLICK_DELAY = 1
// How far ahead of a loop's end the wrap is scheduled
const LOOP_LOOKAHEAD = 0.25
// Segments are kept this long after they end, for position() (which looks back by
// the output latency) and for recordings to read the wraps
const SEGMENT_HISTORY = 2

// The song is mastered to 0 dBFS, which leaves no room above it for the click.
// Turning all song tracks down by this much gives the click real headroom: boosting
// it then makes it louder instead of just pushing it into the limiter.
export const MUSIC_BUS_DB = -6

// Safety limiter: stems plus a loud click can exceed full scale, and the output
// hard-clips (audible crackle). This only acts on peaks above -1 dBFS. Its small
// look-ahead delays every track equally, so sync is unaffected; the recording
// calibration plays through one too, so that delay is measured with the rest.
export function createLimiter(ctx) {
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -1
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.1
  return limiter
}

// clickTrackId: the track that bypasses the music bus (the metronome)
export function createEngine({ clickTrackId = 'metronome' } = {}) {
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  const master = ctx.createGain()
  const limiter = createLimiter(ctx)
  master.connect(limiter)
  limiter.connect(ctx.destination)

  // Everything the shifter acts on (song tracks and clips) meets here
  const shiftInput = ctx.createGain()
  shiftInput.connect(master)

  const musicBus = ctx.createGain()
  musicBus.gain.value = 10 ** (MUSIC_BUS_DB / 20)
  const songLevel = ctx.createGain() // backing level, for the song
  musicBus.connect(songLevel)
  songLevel.connect(shiftInput)

  const clipBus = ctx.createGain()
  clipBus.connect(shiftInput)

  // The click waits as long as the shifter takes, so they stay together
  const clickDelay = ctx.createDelay(MAX_CLICK_DELAY)
  const clickLevel = ctx.createGain() // backing level, for the click
  clickDelay.connect(clickLevel)
  clickLevel.connect(master)
  let shifter = null // pitch shifter node while speed ≠ 1
  let shifterLag = 0 // seconds the music runs behind with the shifter in
  let speedRequest = 0

  const tracks = new Map() // id → { buffer, gain, source, start, clip }
  const loads = new Map() // id → load promise, so each track is fetched once
  let playing = false
  let offset = 0 // song time playback is paused at
  // While playing: [{ when, at, end }], oldest first. Each plays song time `at` from
  // context time `when` until context time `end` (Infinity while not looping).
  let segments = []
  let loop = null // { start, end } in song time, while looping
  let wrapTimer = null
  let segmentCount = 0
  let duration = 0 // song length (seconds)
  let speed = 1
  // Bumped by swapBuffers, so an original track that finishes loading afterwards
  // doesn't replace its key-changed version
  let generation = 0

  function track(id, { clip = false } = {}) {
    let t = tracks.get(id)
    if (!t) {
      const gain = ctx.createGain()
      gain.connect(id === clickTrackId ? clickDelay : clip ? clipBus : musicBus)
      t = { buffer: null, gain, sources: new Set(), start: 0, clip }
      tracks.set(id, t)
    }
    return t
  }

  // Plays a track's part of a segment, from context time `from` (default: the
  // segment's start). Song tracks play at `speed`; the click's buffer is already at
  // the new tempo, so it plays at normal rate from the matching point. A clip that
  // starts later waits for its start.
  function startSource(t, segment, from = segment.when) {
    let when = Math.max(segment.when, from)
    const at = segment.at + (when - segment.when) * speed
    const isClick = t === tracks.get(clickTrackId)
    let bufferAt = isClick ? at / speed : at - t.start
    if (!t.buffer || bufferAt >= t.buffer.duration) return
    if (bufferAt < 0) {
      when -= bufferAt / speed
      bufferAt = 0
    }
    if (when >= segment.end) return
    const source = ctx.createBufferSource()
    source.buffer = t.buffer
    source.playbackRate.value = isClick ? 1 : speed
    source.connect(t.gain)
    source.start(when, bufferAt)
    source.segment = segment
    source.onended = () => {
      source.disconnect()
      t.sources.delete(source)
    }
    t.sources.add(source)
  }

  function stopSource(t) {
    for (const source of t.sources) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    t.sources.clear()
  }

  // A track that arrives mid-playback joins every segment still to play
  function joinIn(t) {
    const from = ctx.currentTime + START_DELAY
    for (const segment of segments) if (segment.end > from) startSource(t, segment, from)
  }

  // Song length: the longest song track (clips and the click don't count)
  const songDuration = () =>
    Math.max(0, ...[...tracks].filter(([id, t]) => id !== clickTrackId && !t.clip).map(([, t]) => t.buffer?.duration ?? 0))

  // The segment playing at context time `time` (the first, before any has started)
  function segmentAt(time) {
    for (let i = segments.length - 1; i > 0; i--) if (segments[i].when <= time) return segments[i]
    return segments[0]
  }

  // Song time at context time `time`, while playing
  function songTimeAt(time) {
    const segment = segmentAt(time)
    return segment.at + Math.max(0, time - segment.when) * speed
  }

  // Starts a segment: every track from song time `at` at context time `when`
  function addSegment(when, at) {
    const segment = { id: ++segmentCount, when, at, end: Infinity }
    segments = segments.filter((s) => s.end > ctx.currentTime - SEGMENT_HISTORY)
    segments.push(segment)
    for (const t of tracks.values()) startSource(t, segment)
    planWrap()
  }

  // Works out when the current segment reaches the loop's end (if it will) and sets
  // up the wrap shortly before. Call whenever the loop changes.
  function planWrap() {
    clearTimeout(wrapTimer)
    const segment = segments.at(-1)
    if (!playing || !segment || segment.wrapped) return
    const now = Math.max(ctx.currentTime, segment.when)
    const songNow = segment.at + (now - segment.when) * speed
    segment.end = loop && songNow < loop.end ? segment.when + (loop.end - segment.at) / speed : Infinity
    if (segment.end === Infinity) return
    wrapTimer = setTimeout(() => wrap(segment), Math.max(0, (segment.end - ctx.currentTime - LOOP_LOOKAHEAD) * 1000))
  }

  function wrap(segment) {
    if (segments.at(-1) !== segment || !loop) return
    segment.wrapped = true
    for (const t of tracks.values()) {
      for (const source of t.sources) if (source.segment === segment) source.stop(segment.end)
    }
    addSegment(segment.end, loop.start)
  }

  function startSources(at) {
    segments = []
    offset = at
    addSegment(ctx.currentTime + START_DELAY, at)
  }

  function stopSources() {
    clearTimeout(wrapTimer)
    for (const t of tracks.values()) stopSource(t)
    segments = []
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
          if (playing) joinIn(t)
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
      if (!playing || segments.length === 0) return offset
      return clamp(songTimeAt(ctx.currentTime - (ctx.outputLatency || 0) - shifterLag))
    },

    play() {
      if (playing || duration === 0) return
      ctx.resume()
      if (offset >= duration) offset = 0
      playing = true // first: starting the sources plans the loop wrap, which only happens while playing
      startSources(offset)
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
      stopSource(t)
      t.buffer = buffer
      if (playing) joinIn(t)
    },

    // Replaces the song tracks all at once (buffers: Map of id → AudioBuffer), e.g.
    // with a key-changed version, or back to the originals. Playback carries on from
    // the same song position.
    swapBuffers(buffers) {
      const at = this.position()
      if (playing) stopSources()
      generation++
      for (const [id, buffer] of buffers) track(id).buffer = buffer
      duration = songDuration()
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
      shiftInput.disconnect()
      if (shifter) closeShifter(shifter)
      shifter = node
      if (shifter) {
        shiftInput.connect(shifter)
        shifter.connect(master)
      } else {
        shiftInput.connect(master)
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

    // True while playback will wrap back to the loop start (rather than run on)
    get looping() {
      return playing && segments.some((s) => s.end < Infinity)
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
      songLevel.gain.setTargetAtTime(value, ctx.currentTime, GAIN_SMOOTHING)
      clickLevel.gain.setTargetAtTime(value, ctx.currentTime, GAIN_SMOOTHING)
    },

    // Puts a clip on track `id`: `buffer` played from song time `start` (seconds,
    // may be negative), replacing what was there. Joins in if playing. Doesn't
    // change the song's duration.
    setClip(id, buffer, start) {
      const t = track(id, { clip: true })
      if (!t.clip) {
        // Its level was set before it loaded, which made it a song track
        t.gain.disconnect()
        t.gain.connect(clipBus)
        t.clip = true
      }
      stopSource(t)
      t.buffer = buffer
      t.start = start
      if (playing) joinIn(t)
    },

    // Every loaded track except the click, for export: Map of id → { buffer, start, clip }
    buffers() {
      const result = new Map()
      for (const [id, t] of tracks) if (id !== clickTrackId && t.buffer) result.set(id, { buffer: t.buffer, start: t.start, clip: t.clip })
      return result
    },

    // Removes a clip track altogether
    removeClip(id) {
      const t = tracks.get(id)
      if (!t?.clip) return
      stopSource(t)
      t.gain.disconnect()
      tracks.delete(id)
    },

    // When each recent segment started coming out of the speakers, on the page's
    // clock: [{ id, performanceTime, songTime }], oldest first. A recording that runs
    // across loop wraps is split into passes with these. Null when not playing.
    heardSegments() {
      if (!playing || segments.length === 0) return null
      const { contextTime, performanceTime } = ctx.getOutputTimestamp()
      if (!(contextTime > 0)) return null
      return segments.map((s) => ({
        id: s.id,
        performanceTime: performanceTime + (s.when + shifterLag - contextTime) * 1000,
        songTime: s.at,
      }))
    },

    // Loops song time { start, end } (null: no loop). Mid-song it takes effect from
    // the current position: playback carries on and wraps at the new end (if the
    // playhead is past it, it plays on to the end of the song).
    setLoop(region) {
      loop = region && region.end > region.start ? { start: region.start, end: region.end } : null
      planWrap()
    },

    // Plays through this output device ('' = the system default). Ids come from
    // navigator.mediaDevices.enumerateDevices(); see output.js. Safe mid-playback.
    setOutputDevice(deviceId) {
      if (ctx.sinkId === deviceId) return Promise.resolve()
      return ctx.setSinkId(deviceId)
    },

    close() {
      clearTimeout(wrapTimer)
      stopSources()
      playing = false
      return ctx.close()
    },
  }
}
