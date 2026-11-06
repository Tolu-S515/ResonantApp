import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Runs processing/process.py and resolves with its final result ({ stems, peaks }).
 *
 * The script speaks a line-based JSON protocol on stdout (see process.py).
 * - onProgress(stage, percent) is called as each stage starts and as it advances
 *   (percent is undefined for stages that don't report it)
 * - onReference({ reference, peaks }) is called once reference.wav and its waveform peaks exist
 * - onAnalysis(analysis) is called as soon as analysis finishes, before separation
 * - onChords(chords) is called once chords are detected, after separation (only
 *   with chordinoPath; skipped quietly if detection fails)
 * - signal (AbortSignal) kills the script; the promise then rejects with a CancelledError
 */
export async function runProcessing({
  pythonPath,
  scriptPath,
  inputPath,
  outputDir,
  chordinoPath,
  onProgress,
  onReference,
  onAnalysis,
  onChords,
  signal,
}) {
  let result = null
  const args = [scriptPath, '--input', inputPath, '--output-dir', outputDir]
  if (chordinoPath) args.push('--chordino', chordinoPath)
  await runScript(pythonPath, args, signal, (message) => {
    if (message.type === 'progress') onProgress?.(message.stage, message.percent)
    else if (message.type === 'reference') onReference?.({ reference: message.reference, peaks: message.peaks })
    else if (message.type === 'analysis') onAnalysis?.(message.analysis)
    else if (message.type === 'chords') onChords?.(message.chords)
    else if (message.type === 'result') result = { stems: message.stems, peaks: message.peaks ?? {} }
  })
  if (!result) throw new Error('Processing exited with code 0 without a result')
  return result
}

/**
 * Detects chords for a session that already has stems (process.py --chords-only)
 * and resolves with them: [{ time, chord }].
 */
export async function runChordDetection({ pythonPath, scriptPath, outputDir, chordinoPath, signal }) {
  let chords = null
  const args = [scriptPath, '--output-dir', outputDir, '--chordino', chordinoPath, '--chords-only']
  await runScript(pythonPath, args, signal, (message) => {
    if (message.type === 'chords') chords = message.chords
  })
  if (!chords) throw new Error('Chord detection finished without a result')
  return chords
}

// Spawns the script and passes each protocol message to onMessage. Resolves when it
// exits cleanly; rejects with its error message (or stderr) otherwise.
function runScript(pythonPath, args, signal, onMessage) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())

    const child = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let errorMessage = null
    // Keep the tail of stderr for crashes that never reach the script's own error handling
    let stderrTail = ''

    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = parseMessage(line)
      if (!message) return
      if (message.type === 'error') errorMessage = message.message
      else onMessage(message)
    })

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })

    // e.g. the Python executable doesn't exist
    child.on('error', (err) => reject(new Error(`Could not start processing: ${err.message}`)))

    // SIGTERM ends Python immediately, mid-Demucs included
    const onAbort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new CancelledError())
      if (code === 0) return resolve()
      const lastStderrLine = stderrTail.trim().split('\n').pop()
      reject(new Error(errorMessage || lastStderrLine || `Processing exited with code ${code}`))
    })
  })
}

export class CancelledError extends Error {
  constructor() {
    super('Processing cancelled')
    this.name = 'CancelledError'
  }
}

// Returns the parsed message, or null for anything that isn't a protocol line
export function parseMessage(line) {
  if (!line.startsWith('{')) return null
  try {
    const message = JSON.parse(line)
    return typeof message?.type === 'string' ? message : null
  } catch {
    return null
  }
}

/**
 * Runs async jobs one at a time, in order. Processing is CPU-heavy (Demucs
 * especially), so parallel jobs would just slow each other down.
 */
export function createJobQueue() {
  let tail = Promise.resolve()
  return function enqueue(job) {
    const run = tail.then(job)
    // A failed job must not block the ones queued after it
    tail = run.catch(() => {})
    return run
  }
}
