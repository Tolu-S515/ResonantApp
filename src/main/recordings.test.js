import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { offsetKey } from '../shared/recording.js'
import { createRecorder, inputLatencyMs, readWav, repairWav } from './recordings.js'
import { createSession, readSession } from './sessions.js'

const BASE = Date.now() // references are checked against the current time
const SAMPLE_RATE = 1000 // small, so files stay tiny
const info = { inputChannels: 2, sampleRate: SAMPLE_RATE, bufferFrames: 4, inputLatencyFrames: 9 } // 5 ms input latency
const settings = { inputUid: 'in', outputUid: 'out', bufferFrames: 4, recordOffset: null }

// 24-bit PCM WAV, as the engine writes it. sizes: false leaves them zero (unfinished).
function wav(channels, frames, { sizes = true, sample = () => 0 } = {}) {
  const data = frames * channels * 3
  const out = Buffer.alloc(44 + data)
  out.write('RIFF', 0)
  out.writeUInt32LE(sizes ? 36 + data : 0, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(SAMPLE_RATE, 24)
  out.writeUInt32LE(SAMPLE_RATE * channels * 3, 28)
  out.writeUInt16LE(channels * 3, 32)
  out.writeUInt16LE(24, 34)
  out.write('data', 36)
  out.writeUInt32LE(sizes ? data : 0, 40)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out.writeIntLE(Math.round(sample(f, c) * 8388607), 44 + (f * channels + c) * 3, 3)
  }
  return out
}

let root
let calls
let engine // what the fake engine does: { frames, startEpochMs, crash, sample }
let trashed
let saved
let running

function recorder() {
  return createRecorder({
    call: async (method, options) => {
      calls.push(method)
      if (method === 'startRecording') {
        engine.targets = options.targets
        engine.muted = options.muteMonitoring
        return null
      }
      if (method === 'stopRecording') {
        for (const t of engine.targets) {
          const channels = t.right >= 0 ? 2 : 1
          await writeFile(t.path, wav(channels, engine.frames, { sizes: !engine.crash, sample: engine.sample }))
        }
        if (engine.crash) throw new Error('The audio engine stopped unexpectedly')
        return { startEpochMs: engine.startEpochMs, frames: engine.frames, dropped: engine.dropped ?? 0, error: null }
      }
      throw new Error(`unexpected ${method}`)
    },
    audioState: async () => ({ settings, info: running ? info : null }),
    sessionsDir: () => join(root, 'sessions'),
    saveAudio: async (changes) => saved.push(changes),
    trash: async (path) => {
      trashed.push(path)
      await rm(path)
    },
    tempDir: () => root,
    now: () => new Date(2026, 10, 6, 14, 25, 1, 123),
  })
}

let session
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resonant-rec-'))
  const song = join(root, 'song.wav')
  await writeFile(song, 'RIFF')
  session = await createSession(join(root, 'sessions'), song)
  calls = []
  trashed = []
  saved = []
  running = true
  engine = { frames: 2000, startEpochMs: BASE + 1000 }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = (path) => access(path).then(() => true, () => false)
const reference = { epochMs: BASE, songTime: 20 }
const takePath = (take) => join(root, 'sessions', session.id, take.file)

describe('recording takes', () => {
  it('saves each track’s take where it was played in the song, and makes it the active take', async () => {
    const r = recorder()
    const { takes: ids } = await r.start(session.id, [{ index: 0, inputs: [0] }, { index: 1, inputs: [1, 0] }], { transpose: 2 })
    expect(ids).toEqual(['take-20261106-142501123-1', 'take-20261106-142501123-2'])
    expect(engine.targets.map((t) => [t.left, t.right])).toEqual([[0, -1], [1, 0]])
    expect(r.recording).toBe(true)

    const { session: updated, takes, warning } = await r.stop({ segments: reference })
    expect(warning).toBeNull()
    expect(r.recording).toBe(false)
    // Captured 1 s after the reference, less 5 ms input latency
    expect(takes[0].start).toBeCloseTo(20.995)
    expect(takes.map((t) => [t.track, t.channels, t.duration, t.transpose])).toEqual([[0, 1, 2, 2], [1, 2, 2, 2]])
    expect(updated.takes).toEqual(takes)
    expect(updated.activeTakes).toEqual({ 0: ids[0], 1: ids[1] })
    expect(await readSession(join(root, 'sessions'), session.id)).toEqual(updated)
    expect(await exists(takePath(takes[0]))).toBe(true)
  })

  it('moves takes by the calibrated offset', async () => {
    settings.recordOffset = { key: offsetKey(settings), ms: -10 }
    try {
      const r = recorder()
      await r.start(session.id, [{ index: 0, inputs: [0] }])
      const { takes } = await r.stop({ segments: reference })
      expect(takes[0].start).toBeCloseTo(20.985)
    } finally {
      settings.recordOffset = null
    }
  })

  it('drops a take too short to be one', async () => {
    engine.frames = 100
    const r = recorder()
    await r.start(session.id, [{ index: 0, inputs: [0] }])
    const path = engine.targets[0].path
    expect(await r.stop({ segments: reference })).toEqual({ session: null, takes: [], warning: null })
    expect(await exists(path)).toBe(false)
    expect((await readSession(join(root, 'sessions'), session.id)).takes).toEqual([])
  })

  it('places the take with the last reference sent, if stop has none (the page went away)', async () => {
    const r = recorder()
    await r.start(session.id, [{ index: 0, inputs: [0] }])
    r.reference(reference)
    const { takes } = await r.abandon()
    expect(takes[0].start).toBeCloseTo(20.995)
  })

  it('finishes the files itself if the engine crashed', async () => {
    engine.crash = true
    const r = recorder()
    await r.start(session.id, [{ index: 0, inputs: [0, 1] }])
    const { takes } = await r.stop({ segments: reference })
    expect(takes[0].duration).toBe(2)
    // Placed from when recording was asked for
    expect(takes[0].start).toBeCloseTo(20 + (new Date(2026, 10, 6, 14, 25, 1, 123).getTime() - reference.epochMs) / 1000 - 0.005)
    const { samples, channels } = await readWav(takePath(takes[0]))
    expect([samples.length, channels]).toEqual([2000, 2])
    const header = await readFile(takePath(takes[0]))
    expect(header.readUInt32LE(40)).toBe(2000 * 2 * 3)
  })

  it('warns when the disk fell behind', async () => {
    engine.dropped = 500
    const r = recorder()
    await r.start(session.id, [{ index: 0, inputs: [0] }])
    expect((await r.stop({ segments: reference })).warning).toMatch(/0\.5 s of the take was lost/)
  })

  it('saves one take per pass round the loop; the track plays the last full pass', async () => {
    // Recording runs 4.4 s; the 2 s loop wrapped 2 s and 4 s after the reference
    engine.frames = 4400
    engine.startEpochMs = BASE + 5 // captured at BASE (5 ms input latency)
    engine.sample = (f) => f / 10000
    const segments = [reference, { epochMs: BASE + 2000, songTime: 20 }, { epochMs: BASE + 4000, songTime: 20 }]
    const r = recorder()
    await r.start(session.id, [{ index: 0, inputs: [0] }])
    const original = engine.targets[0].path
    const { session: updated, takes } = await r.stop({ segments })
    expect(takes.map((t) => [t.id.slice(-2), t.pass, t.start, t.duration])).toEqual([
      ['-1', 1, 20, 2],
      ['-2', 2, 20, 2],
    ]) // the 0.4 s left after the last wrap is too short to keep
    expect(updated.activeTakes[0]).toBe(takes[1].id)
    expect(await exists(original)).toBe(false)
    // The second pass is frames 2000..3999 of the recording
    const { samples } = await readWav(takePath(takes[1]))
    expect(samples.length).toBe(2000)
    expect(samples[0]).toBeCloseTo(0.2, 3)
  })

  it('refuses bad requests', async () => {
    const r = recorder()
    await expect(r.start('nope', [{ index: 0, inputs: [0] }])).rejects.toThrow('Invalid session id')
    await expect(r.start(session.id, [])).rejects.toThrow('Nothing to record')
    await expect(r.start(session.id, [{ index: 0, inputs: [2] }])).rejects.toThrow('Invalid track inputs')
    await expect(r.start(session.id, [{ index: 0, inputs: [0] }, { index: 0, inputs: [1] }])).rejects.toThrow('Invalid track')
    running = false
    await expect(r.start(session.id, [{ index: 0, inputs: [0] }])).rejects.toThrow('Connect your audio interface')
    expect(calls).toEqual([])
  })

  it('refuses to start twice', async () => {
    const r = recorder()
    await r.start(session.id, [{ index: 0, inputs: [0] }])
    await expect(r.start(session.id, [{ index: 1, inputs: [1] }])).rejects.toThrow('Already recording')
  })

  it('does nothing when stopped while not recording', async () => {
    expect(await recorder().stop({ reference })).toBeNull()
  })
})

describe('choosing and deleting takes', () => {
  async function record(r, index) {
    await r.start(session.id, [{ index, inputs: [0] }])
    return (await r.stop({ segments: reference })).takes[0]
  }

  it('switches the take a track plays, or to none', async () => {
    let tick = 0
    const r = createRecorderWithClock(() => new Date(2026, 10, 6, 14, 25, tick++))
    const first = await record(r, 0)
    const second = await record(r, 0)
    expect((await r.setActiveTake(session.id, 0, first.id)).activeTakes[0]).toBe(first.id)
    expect((await r.setActiveTake(session.id, 0, null)).activeTakes[0]).toBeNull()
    await expect(r.setActiveTake(session.id, 1, second.id)).rejects.toThrow('No such take')
  })

  it('moves a deleted take to the Trash; its track falls back to the newest one left', async () => {
    let tick = 0
    const r = createRecorderWithClock(() => new Date(2026, 10, 6, 14, 25, tick++))
    const first = await record(r, 0)
    const second = await record(r, 0)
    const updated = await r.deleteTake(session.id, second.id)
    expect(trashed).toEqual([takePath(second)])
    expect(updated.takes.map((t) => t.id)).toEqual([first.id])
    expect(updated.activeTakes[0]).toBe(first.id)
    expect((await r.deleteTake(session.id, first.id)).activeTakes[0]).toBeNull()
    await expect(r.deleteTake(session.id, '../session')).rejects.toThrow('Invalid take')
  })
})

// recorder() with its own clock, so takes get different ids
function createRecorderWithClock(now) {
  return createRecorder({
      call: async (method, options) => {
        if (method === 'startRecording') {
          engine.targets = options.targets
          return null
        }
        for (const t of engine.targets) await writeFile(t.path, wav(1, engine.frames))
        return { startEpochMs: engine.startEpochMs, frames: engine.frames, dropped: 0, error: null }
      },
      audioState: async () => ({ settings, info }),
      sessionsDir: () => join(root, 'sessions'),
      saveAudio: async () => {},
      trash: async (path) => {
        trashed.push(path)
        await rm(path)
      },
      tempDir: () => root,
      now,
    })
}

describe('calibration', () => {
  it('finds the clicks and saves how far off they were', async () => {
    // Clicks played at 0.5 s and every 0.4 s after; heard in the recording 12 ms later
    // than the reported latency accounts for
    const played = [500, 900, 1300, 1700]
    engine.frames = 2500
    engine.startEpochMs = BASE
    engine.sample = (f) => (played.some((ms) => f >= ms + 5 + 12 && f < ms + 5 + 12 + 4) ? 0.3 : 0)
    const r = recorder()
    await r.startCalibration(1)
    expect(engine.targets[0].left).toBe(1)
    expect(engine.muted).toBe(true)
    const result = await r.finishCalibration(played.map((ms) => engine.startEpochMs + ms))
    expect(result).toEqual({ offsetMs: -12, heard: 4 })
    expect(saved).toEqual([{ recordOffset: { key: offsetKey(settings), ms: -12 } }])
    expect(await exists(join(root, 'calibration.wav'))).toBe(false)
  })

  it('says so when it hears nothing', async () => {
    const r = recorder()
    await r.startCalibration(0)
    await expect(r.finishCalibration([BASE + 500])).rejects.toThrow("Didn't hear the test clicks")
    expect(saved).toEqual([])
  })
})

describe('WAV files', () => {
  it('reads 24-bit samples back', async () => {
    const path = join(root, 'a.wav')
    await writeFile(path, wav(2, 3, { sample: (f, c) => (c === 0 ? [0.5, -0.25, 1][f] : 0) }))
    const { samples, channels, sampleRate } = await readWav(path)
    expect([channels, sampleRate]).toEqual([2, SAMPLE_RATE])
    expect([...samples].map((s) => Number(s.toFixed(4)))).toEqual([0.5, -0.25, 1])
  })

  it('repairs an unfinished header', async () => {
    const path = join(root, 'b.wav')
    await writeFile(path, wav(1, 10, { sizes: false }))
    expect(await repairWav(path, 1)).toBe(10)
    const bytes = await readFile(path)
    expect([bytes.readUInt32LE(4), bytes.readUInt32LE(40)]).toEqual([36 + 30, 30])
  })

  it('works out the input latency without the monitoring buffer', () => {
    expect(inputLatencyMs(info)).toBeCloseTo(5)
  })
})
