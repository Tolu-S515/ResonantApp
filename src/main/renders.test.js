import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RenderCancelledError, createRenderer, ffmpegArgs, renderName, renderPlan } from './renders.js'

const files = {
  reference: 'reference.wav',
  stems: { drums: 'stems/drums.wav', bass: 'stems/bass.wav', vocals: 'stems/vocals.wav' },
}

describe('renderName', () => {
  it('names the folder after the speed and key', () => {
    expect(renderName(0.8, 2)).toBe('speed-0.80_key+2')
    expect(renderName(1, -3)).toBe('speed-1.00_key-3')
    expect(renderName(1.25, 0)).toBe('speed-1.25_key+0')
  })
})

describe('renderPlan', () => {
  it('stretches every track, and pitches all but the drums', () => {
    const plan = renderPlan(files, 0.8, 2)
    expect(plan.find((t) => t.id === 'vocals')).toEqual({
      id: 'vocals',
      source: 'stems/vocals.wav',
      output: 'renders/speed-0.80_key+2/vocals.flac',
      speed: 0.8,
      semitones: 2,
    })
    expect(plan.find((t) => t.id === 'drums')).toMatchObject({ speed: 0.8, semitones: 0 })
    expect(plan.find((t) => t.id === 'reference')).toMatchObject({ semitones: 2 })
  })

  it('keeps the original drums when only the key changes', () => {
    const drums = renderPlan(files, 1, -2).find((t) => t.id === 'drums')
    expect(drums).toEqual({ id: 'drums', source: 'stems/drums.wav', output: 'stems/drums.wav' })
  })

  it('handles a session with only the reference', () => {
    expect(renderPlan({ reference: 'reference.wav' }, 0.9, 0).map((t) => t.id)).toEqual(['reference'])
  })
})

describe('ffmpegArgs', () => {
  const filterOf = (args) => args[args.indexOf('-af') + 1]

  it('stretches with tempo and pitches by frequency ratio, keeping formants', () => {
    const args = ffmpegArgs({ speed: 0.8, semitones: 12 }, 'in.wav', 'out.flac')
    expect(filterOf(args)).toBe('rubberband=pitchq=quality:tempo=0.8:pitch=2:formant=preserved')
    expect(args.slice(0, 6)).toEqual(['-nostdin', '-v', 'error', '-y', '-i', 'in.wav'])
    expect(args.slice(-5)).toEqual(['-c:a', 'flac', '-sample_fmt', 's16', 'out.flac'])
  })

  it('leaves out what does not change', () => {
    expect(filterOf(ffmpegArgs({ speed: 0.8, semitones: 0 }, 'in', 'out'))).toBe('rubberband=pitchq=quality:tempo=0.8')
    expect(filterOf(ffmpegArgs({ speed: 1, semitones: -12 }, 'in', 'out'))).toBe(
      'rubberband=pitchq=quality:pitch=0.5:formant=preserved',
    )
  })
})

describe('createRenderer', () => {
  let dir
  const sessionId = 'session-1'
  let runs
  let clock

  // Pretend rubberband: writes the output file, then exits. `hold` keeps it running until released.
  function fakeSpawn({ hold = false, fail = false } = {}) {
    const held = []
    const spawn = (_command, args) => {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => queueMicrotask(() => child.emit('close', null))
      const finish = async () => {
        if (fail) {
          child.stderr.emit('data', 'Bad input file\n')
          return child.emit('close', 1)
        }
        await writeFile(args.at(-1), 'audio')
        child.emit('close', 0)
      }
      runs.push(args)
      if (hold) held.push(finish)
      else queueMicrotask(finish)
      return child
    }
    return { spawn, release: () => held.splice(0).forEach((finish) => finish()) }
  }

  function renderer(options = {}) {
    return createRenderer({ sessionsDir: () => dir, ffmpeg: () => 'ffmpeg', now: () => clock++, ...options })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'renders-'))
    await mkdir(join(dir, sessionId, 'stems'), { recursive: true })
    runs = []
    clock = 1
  })

  afterEach(() => rm(dir, { recursive: true, force: true }))

  const rendersIn = async () => (await readdir(join(dir, sessionId, 'renders'))).sort()

  it('renders each track to FLAC and reports progress', async () => {
    const progress = []
    const { spawn } = fakeSpawn()
    const result = await renderer({ spawn, onProgress: (_id, p) => progress.push(p.done) }).prepare(sessionId, files, 0.8, 2)
    expect(result).toEqual({
      reference: 'renders/speed-0.80_key+2/reference.flac',
      drums: 'renders/speed-0.80_key+2/drums.flac',
      bass: 'renders/speed-0.80_key+2/bass.flac',
      vocals: 'renders/speed-0.80_key+2/vocals.flac',
    })
    expect(runs).toHaveLength(4)
    expect(progress).toEqual([0, 1, 2, 3, 4])
    expect(await rendersIn()).toEqual(['speed-0.80_key+2'])
    const manifest = JSON.parse(await readFile(join(dir, sessionId, 'renders/speed-0.80_key+2/render.json'), 'utf8'))
    expect(manifest).toMatchObject({ speed: 0.8, transpose: 2, files: result })
  })

  it('reuses a finished render without running Rubber Band again', async () => {
    const { spawn } = fakeSpawn()
    const r = renderer({ spawn })
    await r.prepare(sessionId, files, 0.8, 0)
    runs.length = 0
    await r.prepare(sessionId, files, 0.8, 0)
    expect(runs).toEqual([])
  })

  it('uses the original files at 100% with no key change', async () => {
    const result = await renderer({ spawn: fakeSpawn().spawn }).prepare(sessionId, files, 1, 0)
    expect(result).toEqual({
      reference: 'reference.wav',
      drums: 'stems/drums.wav',
      bass: 'stems/bass.wav',
      vocals: 'stems/vocals.wav',
    })
    expect(runs).toEqual([])
  })

  it('keeps only the 2 most recently used renders', async () => {
    const r = renderer({ spawn: fakeSpawn().spawn })
    await r.prepare(sessionId, files, 0.8, 0)
    await r.prepare(sessionId, files, 0.9, 0)
    await r.prepare(sessionId, files, 0.8, 0) // used again: now the newest
    await r.prepare(sessionId, files, 0.7, 0)
    expect(await rendersIn()).toEqual(['speed-0.70_key+0', 'speed-0.80_key+0'])
  })

  it('cancels a render when another speed is chosen, leaving nothing half-written', async () => {
    const slow = fakeSpawn({ hold: true })
    const r = renderer({ spawn: slow.spawn })
    const first = r.prepare(sessionId, files, 0.8, 0)
    await new Promise((resolve) => setTimeout(resolve, 10)) // let it start
    const second = r.prepare(sessionId, { reference: 'reference.wav' }, 1, 0)
    await expect(first).rejects.toBeInstanceOf(RenderCancelledError)
    await expect(second).resolves.toEqual({ reference: 'reference.wav' })
    expect(existsSync(join(dir, sessionId, 'renders/speed-0.80_key+0.partial'))).toBe(false)
    expect(existsSync(join(dir, sessionId, 'renders/speed-0.80_key+0'))).toBe(false)
  })

  it('shares one render between repeated requests for the same speed and key', async () => {
    const slow = fakeSpawn({ hold: true })
    const r = renderer({ spawn: slow.spawn, parallel: 8 })
    const a = r.prepare(sessionId, files, 0.8, 0)
    const b = r.prepare(sessionId, files, 0.8, 0)
    expect(b).toBe(a)
    await new Promise((resolve) => setTimeout(resolve, 10))
    slow.release()
    await a
    expect(runs).toHaveLength(4)
  })

  it('reports Rubber Band errors and cleans up', async () => {
    const r = renderer({ spawn: fakeSpawn({ fail: true }).spawn })
    await expect(r.prepare(sessionId, files, 0.8, 0)).rejects.toThrow('Rendering failed: Bad input file')
    expect(await rendersIn()).toEqual([])
  })

  it('explains when ffmpeg is missing', async () => {
    const spawn = () => {
      const child = new EventEmitter()
      child.kill = () => {}
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })))
      return child
    }
    await expect(renderer({ spawn }).prepare(sessionId, files, 0.8, 0)).rejects.toThrow('brew install ffmpeg')
  })
})
