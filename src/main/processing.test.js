import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CancelledError, createJobQueue, parseMessage, runChordDetection, runProcessing } from './processing.js'

describe('parseMessage', () => {
  it('parses protocol lines', () => {
    expect(parseMessage('{"type": "progress", "stage": "analyzing"}')).toEqual({
      type: 'progress',
      stage: 'analyzing',
    })
  })

  it('ignores non-JSON output', () => {
    expect(parseMessage('[ INFO ] some library log')).toBeNull()
    expect(parseMessage('')).toBeNull()
  })

  it('ignores malformed JSON', () => {
    expect(parseMessage('{"type": "progress"')).toBeNull()
  })

  it('ignores JSON without a string type', () => {
    expect(parseMessage('{"stage": "analyzing"}')).toBeNull()
    expect(parseMessage('{"type": 3}')).toBeNull()
  })
})

// Fake processing scripts, run with Node instead of Python, to exercise the
// spawn/parse/error handling without needing the real pipeline.
describe('runProcessing', () => {
  let dir

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resonant-proc-test-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function fakeScript(name, source) {
    const path = join(dir, name)
    await writeFile(path, source)
    return path
  }

  const run = (scriptPath, callbacks = {}) =>
    runProcessing({
      pythonPath: process.execPath,
      scriptPath,
      inputPath: '/in/original.mp3',
      outputDir: '/out',
      ...callbacks,
    })

  it('reports stages, reference, progress and analysis, then resolves with stems and peaks', async () => {
    const script = await fakeScript(
      'ok.js',
      `
      const say = (m) => console.log(JSON.stringify(m))
      say({ type: 'progress', stage: 'normalizing' })
      say({ type: 'reference', reference: 'reference.wav', peaks: 'peaks/reference.json' })
      console.log('noise that is not part of the protocol')
      say({ type: 'progress', stage: 'analyzing' })
      say({ type: 'analysis', analysis: { bpm: 120, key: 'C', scale: 'major' } })
      say({ type: 'progress', stage: 'separating', percent: 0 })
      say({ type: 'progress', stage: 'separating', percent: 100 })
      say({ type: 'result', stems: { drums: 'stems/drums.wav' }, peaks: { drums: 'peaks/drums.json' } })
      `,
    )
    const events = []
    const result = await run(script, {
      onProgress: (stage, percent) => events.push(['progress', stage, percent]),
      onReference: (reference) => events.push(['reference', reference]),
      onAnalysis: (analysis) => events.push(['analysis', analysis.key]),
    })

    expect(result).toEqual({ stems: { drums: 'stems/drums.wav' }, peaks: { drums: 'peaks/drums.json' } })
    expect(events).toEqual([
      ['progress', 'normalizing', undefined],
      ['reference', { reference: 'reference.wav', peaks: 'peaks/reference.json' }],
      ['progress', 'analyzing', undefined],
      ['analysis', 'C'],
      ['progress', 'separating', 0],
      ['progress', 'separating', 100],
    ])
  })

  it('passes the input and output paths as arguments', async () => {
    const script = await fakeScript(
      'args.js',
      `console.log(JSON.stringify({ type: 'result', stems: { argv: process.argv.slice(2) } }))`,
    )
    const result = await run(script)
    expect(result.stems.argv).toEqual(['--input', '/in/original.mp3', '--output-dir', '/out'])
  })

  it('passes the chordino path, and reports detected chords', async () => {
    const script = await fakeScript(
      'chords.js',
      `console.log(JSON.stringify({ type: 'chords', chords: [{ time: 0.5, chord: 'A' }] }))
      console.log(JSON.stringify({ type: 'result', stems: { argv: process.argv.slice(2) } }))`,
    )
    const onChords = vi.fn()
    const result = await run(script, { chordinoPath: '/bin/chordino', onChords })
    expect(onChords).toHaveBeenCalledWith([{ time: 0.5, chord: 'A' }])
    expect(result.stems.argv.slice(-2)).toEqual(['--chordino', '/bin/chordino'])
  })

  it('rejects if the script fails after sending its analysis', async () => {
    const script = await fakeScript(
      'late-error.js',
      `
      console.log(JSON.stringify({ type: 'analysis', analysis: { bpm: 90 } }))
      console.log(JSON.stringify({ type: 'error', message: 'RuntimeError: out of memory' }))
      process.exit(1)
      `,
    )
    const analyses = []
    await expect(run(script, { onAnalysis: (a) => analyses.push(a) })).rejects.toThrow(
      'RuntimeError: out of memory',
    )
    expect(analyses).toEqual([{ bpm: 90 }])
  })

  it("rejects with the script's own error message", async () => {
    const script = await fakeScript(
      'error.js',
      `
      console.log(JSON.stringify({ type: 'error', message: 'Could not read audio file: bad header' }))
      process.exit(1)
      `,
    )
    await expect(run(script)).rejects.toThrow('Could not read audio file: bad header')
  })

  it('falls back to the last stderr line when the script crashes', async () => {
    const script = await fakeScript(
      'crash.js',
      `
      console.error('Traceback (most recent call last):')
      console.error('MemoryError: out of memory')
      process.exit(1)
      `,
    )
    await expect(run(script)).rejects.toThrow('MemoryError: out of memory')
  })

  it('rejects when the script exits cleanly without a result', async () => {
    const script = await fakeScript('silent.js', `process.exit(0)`)
    await expect(run(script)).rejects.toThrow('Processing exited with code 0')
  })

  it('rejects when the interpreter cannot be started', async () => {
    const promise = runProcessing({
      pythonPath: join(dir, 'no-such-python'),
      scriptPath: 'process.py',
      inputPath: 'a',
      outputDir: 'b',
    })
    await expect(promise).rejects.toThrow('Could not start processing')
  })

  it('kills the script and rejects with CancelledError when aborted', async () => {
    const script = await fakeScript(
      'slow.js',
      `console.log(JSON.stringify({ type: 'progress', stage: 'separating', percent: 10 }))
      setTimeout(() => {}, 60_000)`,
    )
    const controller = new AbortController()
    const started = Date.now()
    const promise = run(script, {
      signal: controller.signal,
      // Abort once the script is clearly running
      onProgress: () => controller.abort(),
    })
    await expect(promise).rejects.toBeInstanceOf(CancelledError)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not start the script if already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const onProgress = vi.fn()
    const script = await fakeScript('never.js', `console.log('{"type":"progress","stage":"normalizing"}')`)
    await expect(run(script, { signal: controller.signal, onProgress })).rejects.toBeInstanceOf(CancelledError)
    expect(onProgress).not.toHaveBeenCalled()
  })
})

describe('runChordDetection', () => {
  let dir

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resonant-chords-test-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const detect = async (source) => {
    const scriptPath = join(dir, `script-${Math.random()}.js`)
    await writeFile(scriptPath, source)
    return runChordDetection({ pythonPath: process.execPath, scriptPath, outputDir: '/out', chordinoPath: '/bin/chordino' })
  }

  it('runs in chords-only mode and resolves with the chords', async () => {
    const chords = await detect(
      `console.log(JSON.stringify({ type: 'chords', chords: [{ time: 0, chord: process.argv.slice(2).join(' ') }] }))`,
    )
    expect(chords).toEqual([{ time: 0, chord: '--output-dir /out --chordino /bin/chordino --chords-only' }])
  })

  it("rejects with the script's error", async () => {
    await expect(
      detect(`console.log(JSON.stringify({ type: 'error', message: 'No stems to detect chords from' })); process.exit(1)`),
    ).rejects.toThrow('No stems to detect chords from')
  })
})

describe('createJobQueue', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('runs jobs one at a time, in order', async () => {
    const enqueue = createJobQueue()
    const events = []
    const job = (name) => async () => {
      events.push(`${name} start`)
      await tick()
      events.push(`${name} end`)
    }

    await Promise.all([enqueue(job('a')), enqueue(job('b'))])
    expect(events).toEqual(['a start', 'a end', 'b start', 'b end'])
  })

  it('keeps running later jobs after one fails', async () => {
    const enqueue = createJobQueue()
    const failed = enqueue(async () => {
      throw new Error('boom')
    })
    const next = enqueue(async () => 'still ran')

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('still ran')
  })
})
