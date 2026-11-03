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
 * - signal (AbortSignal) kills the script; the promise then rejects with a CancelledError
 */
export function runProcessing({
  pythonPath,
  scriptPath,
  inputPath,
  outputDir,
  onProgress,
  onReference,
  onAnalysis,
  signal,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())

    const child = spawn(pythonPath, [scriptPath, '--input', inputPath, '--output-dir', outputDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let result = null
    let errorMessage = null
    // Keep the tail of stderr for crashes that never reach the script's own error handling
    let stderrTail = ''

    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = parseMessage(line)
      if (!message) return
      if (message.type === 'progress') onProgress?.(message.stage, message.percent)
      else if (message.type === 'reference') onReference?.({ reference: message.reference, peaks: message.peaks })
      else if (message.type === 'analysis') onAnalysis?.(message.analysis)
      else if (message.type === 'result') result = { stems: message.stems, peaks: message.peaks ?? {} }
      else if (message.type === 'error') errorMessage = message.message
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
      if (code === 0 && result) return resolve(result)
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
