// Recording takes on instrument tracks, and the loopback calibration that lines
// them up with the song. The native engine writes the files (see engine.h); this
// decides where they go, places them on the song timeline and saves them with the
// session. Timing is explained in shared/recording.js.
//
// A take: { id, track, file, start, duration, channels, inputs, sampleRate,
//           transpose, createdAt, pass }
//   pass: which time round the loop it was (1, 2, …), for takes recorded while looping.
//   track: instrument track index. file: path in the session folder.
//   start: song time (seconds) of its first frame, possibly before 0.
//   transpose: the key change it was played along to.
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_TRACKS } from '../shared/audio-settings.js'
import {
  MIN_TAKE_SECONDS,
  calibrationOffset,
  findPulses,
  offsetKey,
  recordOffsetMs,
  sanitizeSegments,
  takePasses,
} from '../shared/recording.js'
import { isSessionId, readSession, sessionPath, updateSession } from './sessions.js'

const TAKE_ID = /^take-[0-9]{8}-[0-9]{9}-[1-8](-[0-9]{1,4})?$/
const WAV_HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 3 // the engine writes 24-bit

// Input latency the driver reports, without the buffer the engine counts in for monitoring
export const inputLatencyMs = (info) =>
  (Math.max(0, info.inputLatencyFrames - info.bufferFrames) / info.sampleRate) * 1000

// "take-20261106-142501123-1": when it started (local time, to the ms) and its track
function takeId(date, track) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
  return `take-${day}-${time}-${track + 1}`
}

// Which tracks to record, from the page: [{ index, inputs }], checked against the interface
function sanitizeTargets(tracks, inputChannels) {
  if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > MAX_TRACKS) throw new Error('Nothing to record')
  const seen = new Set()
  return tracks.map((track) => {
    const { index, inputs } = track ?? {}
    if (!Number.isInteger(index) || index < 0 || index >= MAX_TRACKS || seen.has(index)) throw new Error('Invalid track')
    seen.add(index)
    const valid =
      Array.isArray(inputs) &&
      (inputs.length === 1 || inputs.length === 2) &&
      inputs.every((c) => Number.isInteger(c) && c >= 0 && c < inputChannels) &&
      new Set(inputs).size === inputs.length
    if (!valid) throw new Error('Invalid track inputs')
    return { index, inputs: [...inputs] }
  })
}

// Reads a PCM WAV (16/24-bit integer or 32-bit float): its first channel as floats
export async function readWav(path) {
  const bytes = await readFile(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at) => bytes.toString('latin1', at, at + 4)
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('Not a WAV file')
  let format = null
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = text(at)
    let size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data' && format) {
      if (size === 0 || body + size > bytes.length) size = bytes.length - body // unfinished file
      const width = format.bits / 8
      const frames = Math.floor(size / (width * format.channels))
      const samples = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        const i = body + f * width * format.channels
        if (format.code === 3 && width === 4) samples[f] = view.getFloat32(i, true)
        else if (width === 2) samples[f] = view.getInt16(i, true) / 32768
        else if (width === 3) samples[f] = (((view.getUint8(i + 2) << 24) | (view.getUint8(i + 1) << 16) | (view.getUint8(i) << 8)) >> 8) / 8388608
        else throw new Error('Unsupported WAV format')
      }
      return { sampleRate: format.sampleRate, channels: format.channels, samples }
    }
    at = body + size + (size % 2)
  }
  throw new Error('WAV file has no audio')
}

// A 24-bit PCM WAV header, as the engine writes it
function wavHeader(channels, sampleRate, frames) {
  const data = frames * channels * BYTES_PER_SAMPLE
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(data, 40)
  return header
}

// Writes frames [from, to) of an engine-written take (bytes) to a new file
async function writeSlice(bytes, path, channels, sampleRate, from, to) {
  const frameBytes = channels * BYTES_PER_SAMPLE
  const body = bytes.subarray(WAV_HEADER_BYTES + from * frameBytes, WAV_HEADER_BYTES + to * frameBytes)
  await writeFile(path, Buffer.concat([wavHeader(channels, sampleRate, to - from), body]))
}

// Fixes the sizes in a take's header from the file's length, for a file the engine
// couldn't finish (it crashed). Returns the number of frames.
export async function repairWav(path, channels) {
  const file = await open(path, 'r+')
  try {
    const { size } = await file.stat()
    const frames = Math.max(0, Math.floor((size - WAV_HEADER_BYTES) / (channels * BYTES_PER_SAMPLE)))
    const data = frames * channels * BYTES_PER_SAMPLE
    const field = Buffer.alloc(4)
    field.writeUInt32LE(36 + data)
    await file.write(field, 0, 4, 4)
    field.writeUInt32LE(data)
    await file.write(field, 0, 4, 40)
    return frames
  } finally {
    await file.close()
  }
}

// call(method, ...args): the audio engine (see audio-host.js).
// audioState(): { settings, info } from the audio controller.
// saveAudio(changes): saves the 'audio' settings section. trash(path): moves a file to the Trash.
// tempDir(): where the calibration recording goes. now(): the time.
export function createRecorder({ call, audioState, sessionsDir, saveAudio, trash, tempDir, now = () => new Date() }) {
  let active = null // what's being recorded: a set of takes, or the calibration

  async function runningAudio() {
    const { settings, info } = await audioState()
    if (!info) throw new Error('Connect your audio interface to record')
    return { settings, info }
  }

  async function removeFiles(paths) {
    await Promise.all(paths.map((path) => rm(path, { force: true })))
  }

  // Stops the engine's recording. If the engine has gone (crashed), the files are
  // finished here instead and the start time falls back to when recording was asked for.
  async function stopEngine(recording, channels) {
    try {
      return await call('stopRecording')
    } catch {
      const frames = await Promise.all(recording.targets.map((t, i) => repairWav(t.path, channels[i]).catch(() => 0)))
      return { startEpochMs: recording.requestedAt, frames: Math.min(...frames), dropped: 0, error: null }
    }
  }

  return {
    get recording() {
      return active?.kind === 'takes'
    },

    // Starts recording these instrument tracks ([{ index, inputs }]) into the session.
    // transpose: the key change playing, saved with the takes.
    async start(sessionId, tracks, { transpose = 0 } = {}) {
      if (!isSessionId(sessionId)) throw new Error('Invalid session id')
      if (!Number.isInteger(transpose)) throw new Error('Invalid key change')
      if (active) throw new Error('Already recording')
      const { settings, info } = await runningAudio()
      const targets = sanitizeTargets(tracks, info.inputChannels)
      await readSession(sessionsDir(), sessionId) // it exists
      await mkdir(sessionPath(sessionsDir(), sessionId, 'recordings'), { recursive: true })
      const startedAt = now()
      const recording = {
        kind: 'takes',
        sessionId,
        transpose,
        settings,
        info,
        segments: null,
        requestedAt: startedAt.getTime(),
        createdAt: startedAt.toISOString(),
        targets: targets.map(({ index, inputs }) => {
          const id = takeId(startedAt, index)
          const file = `recordings/${id}.wav`
          return { id, track: index, inputs, file, path: sessionPath(sessionsDir(), sessionId, file) }
        }),
      }
      active = recording
      try {
        await call('startRecording', {
          targets: recording.targets.map((t) => ({ path: t.path, left: t.inputs[0], right: t.inputs[1] ?? -1 })),
        })
      } catch (err) {
        active = null
        await removeFiles(recording.targets.map((t) => t.path))
        throw err
      }
      return { takes: recording.targets.map((t) => t.id) }
    },

    // Which song time was being heard when, from the page: one reference
    // ({ epochMs, songTime }) per stretch of playback (playback restarts at each loop
    // wrap). Sent during recording, so the take can still be placed if the page goes
    // away before it stops.
    reference(segments) {
      if (active?.kind === 'takes') active.segments = sanitizeSegments(segments)
    },

    // Stops recording and saves the takes with the session: one per track, or one per
    // track per pass if the loop wrapped meanwhile. Too-short takes aren't kept.
    // segments: as for reference(). Resolves { session, takes, warning }, or null if
    // nothing was recording.
    async stop({ segments } = {}) {
      if (active?.kind !== 'takes') return null
      const recording = active
      active = null
      if (segments) recording.segments = sanitizeSegments(segments)
      const channels = recording.targets.map((t) => t.inputs.length)
      const result = await stopEngine(recording, channels)
      const { sampleRate } = recording.info
      const duration = result.frames / sampleRate
      const paths = recording.targets.map((t) => t.path)

      if (!result.startEpochMs || !recording.segments || duration < MIN_TAKE_SECONDS) {
        await removeFiles(paths)
        return { session: null, takes: [], warning: null }
      }
      const capturedAtMs = result.startEpochMs - inputLatencyMs(recording.info) + recordOffsetMs(recording.settings)
      const passes = takePasses({ frames: result.frames, sampleRate, capturedAtMs, segments: recording.segments })
      const kept = passes.filter((p) => (p.to - p.from) / sampleRate >= MIN_TAKE_SECONDS)
      const looped = passes.length > 1
      const describe = (t, i, pass, n) => ({
        id: looped ? `${t.id}-${n}` : t.id,
        track: t.track,
        file: looped ? `recordings/${t.id}-${n}.wav` : t.file,
        start: pass.start,
        duration: (pass.to - pass.from) / sampleRate,
        channels: channels[i],
        inputs: t.inputs,
        sampleRate,
        transpose: recording.transpose,
        createdAt: recording.createdAt,
        ...(looped && { pass: n }),
      })
      const takes = recording.targets.flatMap((t, i) => kept.map((pass, n) => describe(t, i, pass, n + 1)))
      if (looped) {
        // One file per pass, cut from the whole recording
        for (const [i, target] of recording.targets.entries()) {
          const bytes = await readFile(target.path)
          for (const [n, pass] of kept.entries()) {
            const path = sessionPath(sessionsDir(), recording.sessionId, `recordings/${target.id}-${n + 1}.wav`)
            await writeSlice(bytes, path, channels[i], sampleRate, pass.from, pass.to)
          }
        }
        await removeFiles(paths)
      }
      if (takes.length === 0) return { session: null, takes: [], warning: null }
      // Each track plays its last full pass round the loop (or its only take)
      const chosen = kept.findLastIndex((p) => p.endsAtWrap)
      const pick = (chosen === -1 ? kept.length : chosen + 1) - 1
      const playing = Object.fromEntries(recording.targets.map((t, i) => [t.track, takes[i * kept.length + pick].id]))
      const session = await updateSession(sessionsDir(), recording.sessionId, (current) => ({
        takes: [...(current.takes ?? []), ...takes],
        activeTakes: { ...current.activeTakes, ...playing },
      }))
      let warning = result.error
      if (!warning && result.dropped > 0) {
        warning = `The disk fell behind and ${(result.dropped / sampleRate).toFixed(1)} s of the take was lost, so its end may be out of time.`
      }
      return { session, takes, warning }
    },

    // Which take an instrument track plays (null: none)
    async setActiveTake(sessionId, track, takeIdOrNull) {
      if (!isSessionId(sessionId)) throw new Error('Invalid session id')
      if (!Number.isInteger(track) || track < 0 || track >= MAX_TRACKS) throw new Error('Invalid track')
      return updateSession(sessionsDir(), sessionId, (current) => {
        if (takeIdOrNull !== null && !(current.takes ?? []).some((t) => t.id === takeIdOrNull && t.track === track)) {
          throw new Error('No such take')
        }
        return { activeTakes: { ...current.activeTakes, [track]: takeIdOrNull } }
      })
    },

    // Moves a take's file to the Trash and forgets it. If its track was playing it,
    // the track switches to its newest remaining take.
    async deleteTake(sessionId, id) {
      if (!isSessionId(sessionId)) throw new Error('Invalid session id')
      if (typeof id !== 'string' || !TAKE_ID.test(id)) throw new Error('Invalid take')
      const session = await readSession(sessionsDir(), sessionId)
      const take = (session.takes ?? []).find((t) => t.id === id)
      if (!take) throw new Error('No such take')
      await trash(sessionPath(sessionsDir(), sessionId, take.file)).catch((err) => {
        if (err.code !== 'ENOENT') throw err
      })
      return updateSession(sessionsDir(), sessionId, (current) => {
        const takes = (current.takes ?? []).filter((t) => t.id !== id)
        const activeTakes = { ...current.activeTakes }
        if (activeTakes[take.track] === id) activeTakes[take.track] = takes.findLast((t) => t.track === take.track)?.id ?? null
        return { takes, activeTakes }
      })
    },

    // Calibration, step 1: records `inputChannel` (with monitoring muted, so the
    // cable can't feed back). The page then plays clicks out of output 1.
    async startCalibration(inputChannel) {
      if (active) throw new Error('Already recording')
      const { settings, info } = await runningAudio()
      if (!Number.isInteger(inputChannel) || inputChannel < 0 || inputChannel >= info.inputChannels) {
        throw new Error('No such input')
      }
      const path = join(tempDir(), 'calibration.wav')
      active = { kind: 'calibration', path, settings, info }
      try {
        await call('startRecording', { targets: [{ path, left: inputChannel, right: -1 }], muteMonitoring: true })
      } catch (err) {
        active = null
        throw err
      }
    },

    // Step 2: expectedMs are when the page's clicks came out of the speakers (wall
    // clock). Finds them in the recording, saves the offset and resolves { offsetMs, heard }.
    async finishCalibration(expectedMs) {
      if (active?.kind !== 'calibration') throw new Error('Calibration isn’t running')
      const { path, settings, info } = active
      active = null
      try {
        const result = await call('stopRecording')
        if (!Array.isArray(expectedMs) || !expectedMs.every(Number.isFinite)) throw new Error('Invalid calibration')
        const { samples, sampleRate } = await readWav(path)
        const latency = inputLatencyMs(info)
        const heard = findPulses(samples, sampleRate).map((f) => result.startEpochMs + (f / sampleRate) * 1000 - latency)
        const offsetMs = calibrationOffset(expectedMs, heard)
        if (offsetMs === null) {
          throw new Error(
            "Didn't hear the test clicks. Connect a cable from output 1 to the input, turn the output up, and try again.",
          )
        }
        await saveAudio({ recordOffset: { key: offsetKey(settings), ms: offsetMs } })
        return { offsetMs, heard: heard.length }
      } finally {
        await rm(path, { force: true })
      }
    },

    // The page that was recording went away (closed or reloaded): keep what was
    // recorded, placed with the last reference it sent. Calibration is just dropped.
    async abandon() {
      if (active?.kind === 'takes') return this.stop()
      if (active?.kind === 'calibration') {
        const { path } = active
        active = null
        await call('stopRecording').catch(() => {})
        await rm(path, { force: true })
      }
      return null
    },
  }
}
