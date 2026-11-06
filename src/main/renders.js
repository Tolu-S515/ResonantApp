// Key changes (and, if ever asked, speed changes; the player does speed live): the
// session's existing stems (and reference) run through Rubber Band (ffmpeg's
// rubberband filter), into renders/<name>/ as 16-bit FLAC. Only the 2 most recently used renders
// are kept per session. The original files are never changed, and 100% speed with
// no key change just uses them.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RENDERS_DIR = 'renders'
export const KEEP_RENDERS = 2
// Tracks rendered at once. On a 4-core Intel laptop 2 and 4 both took ~130 s for a
// 7¾-minute song (the CPU throttles), so 2: same speed, cooler and quieter.
export const PARALLEL_TRACKS = 2
const MANIFEST = 'render.json'
const PARTIAL = '.partial'
// Drums have no key: pitching them only changes their tone, so they're only stretched
const UNPITCHED = new Set(['drums'])

export const isOriginal = (speed, transpose) => speed === 1 && transpose === 0

// Folder name for a speed and key change, e.g. speed-0.80_key+2
export function renderName(speed, transpose) {
  return `speed-${speed.toFixed(2)}_key${transpose >= 0 ? '+' : ''}${transpose}`
}

// One entry per track: { id, source, output } plus, when it needs rendering,
// { speed, semitones }. Tracks that need no change (drums with only a key change)
// keep their original file, and so does everything at 100% with no key change.
export function renderPlan(files, speed, transpose) {
  const name = renderName(speed, transpose)
  const tracks = { reference: files.reference, ...(files.stems ?? {}) }
  return Object.entries(tracks)
    .filter(([, source]) => source)
    .map(([id, source]) => {
      const semitones = UNPITCHED.has(id) ? 0 : transpose
      if (speed === 1 && semitones === 0) return { id, source, output: source }
      return { id, source, output: `${RENDERS_DIR}/${name}/${id}.flac`, speed, semitones }
    })
}

// ffmpeg arguments for one track. Rubber Band's standard (R2) engine, ~15–30 s per
// 5-minute stem on an Intel laptop (the R3 "finer" engine took ~95 s). Through ffmpeg
// rather than the rubberband tool because ffmpeg writes 16-bit FLAC (the tool only
// writes 24-bit, larger than the originals) and never changes a track's level (the tool
// restarts a track that would clip at a lower volume, which upsets the mix balance).
// formant=preserved keeps voices natural when the key moves.
export function ffmpegArgs({ speed, semitones }, input, output) {
  const filter = ['rubberband=pitchq=quality']
  if (speed !== 1) filter.push(`tempo=${speed}`)
  if (semitones !== 0) filter.push(`pitch=${2 ** (semitones / 12)}`, 'formant=preserved')
  return ['-nostdin', '-v', 'error', '-y', '-i', input, '-af', filter.join(':'), '-c:a', 'flac', '-sample_fmt', 's16', output]
}

// The installed ffmpeg (Homebrew on Apple Silicon or Intel), else whatever PATH finds
export function findFfmpeg() {
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((path) => existsSync(path)) ?? 'ffmpeg'
}

export class RenderCancelledError extends Error {
  constructor() {
    super('Render cancelled')
    this.name = 'RenderCancelledError'
  }
}

function runFfmpeg(spawn, command, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RenderCancelledError())
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-1000)
    })
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(
        err.code === 'ENOENT'
          ? new Error("ffmpeg isn't installed. Install it with: brew install ffmpeg")
          : new Error(`Could not start ffmpeg: ${err.message}`),
      )
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new RenderCancelledError())
      if (code === 0) return resolve()
      const lastLine = stderrTail.trim().split('\n').pop()
      if (/No such filter: 'rubberband'/.test(stderrTail)) {
        return reject(new Error("This ffmpeg wasn't built with Rubber Band. Install Homebrew's: brew install ffmpeg"))
      }
      reject(new Error(`Rendering failed: ${lastLine || `ffmpeg exit code ${code}`}`))
    })
  })
}

// Runs `task` over `items`, at most `limit` at a time; stops starting new ones after a failure
async function runLimited(items, limit, task) {
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await task(item)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))
  const rejected = results.find((r) => r.status === 'rejected')
  if (rejected) throw rejected.reason
}

async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'))
  } catch {
    return null // missing (unfinished) or unreadable: treat as not rendered
  }
}

// sessionsDir: the folder of session folders. onProgress(sessionId, { name, done, total }).
export function createRenderer({
  sessionsDir,
  ffmpeg = findFfmpeg,
  spawn = nodeSpawn,
  onProgress,
  now = Date.now,
  parallel = PARALLEL_TRACKS,
}) {
  const active = new Map() // sessionId → { name, controller, promise }

  // Deletes all but the KEEP_RENDERS most recently used renders, plus leftovers
  // from interrupted ones (never the one being rendered)
  async function prune(sessionDir, keepName) {
    const rendersDir = join(sessionDir, RENDERS_DIR)
    let names
    try {
      names = await readdir(rendersDir)
    } catch {
      return
    }
    const finished = []
    for (const name of names) {
      if (name.endsWith(PARTIAL)) {
        if (name !== `${keepName}${PARTIAL}`) await rm(join(rendersDir, name), { recursive: true, force: true })
        continue
      }
      const manifest = await readManifest(join(rendersDir, name))
      if (!manifest) await rm(join(rendersDir, name), { recursive: true, force: true })
      else finished.push({ name, usedAt: name === keepName ? Infinity : manifest.usedAt ?? 0 })
    }
    finished.sort((a, b) => b.usedAt - a.usedAt)
    for (const { name } of finished.slice(KEEP_RENDERS)) {
      await rm(join(rendersDir, name), { recursive: true, force: true })
    }
  }

  async function render(sessionId, files, speed, transpose, signal) {
    const sessionDir = join(sessionsDir(), sessionId)
    const name = renderName(speed, transpose)
    const finalDir = join(sessionDir, RENDERS_DIR, name)
    const plan = renderPlan(files, speed, transpose)
    const result = Object.fromEntries(plan.map((track) => [track.id, track.output]))

    // Already rendered: mark it as just used
    const manifest = await readManifest(finalDir)
    if (manifest) {
      await writeFile(join(finalDir, MANIFEST), JSON.stringify({ ...manifest, usedAt: now() }))
      await prune(sessionDir, name)
      return manifest.files
    }

    const partialDir = `${finalDir}${PARTIAL}`
    await rm(partialDir, { recursive: true, force: true })
    await mkdir(partialDir, { recursive: true })
    const toRender = plan.filter((track) => track.speed !== undefined)
    let done = 0
    onProgress?.(sessionId, { name, done, total: toRender.length })
    try {
      await runLimited(toRender, parallel, async (track) => {
        const args = ffmpegArgs(track, join(sessionDir, track.source), join(partialDir, `${track.id}.flac`))
        await runFfmpeg(spawn, ffmpeg(), args, signal)
        done++
        onProgress?.(sessionId, { name, done, total: toRender.length })
      })
      if (signal.aborted) throw new RenderCancelledError()
    } catch (err) {
      await rm(partialDir, { recursive: true, force: true })
      throw err
    }

    // Only a complete render moves into place, so a half-finished one is never used
    await writeFile(join(partialDir, MANIFEST), JSON.stringify({ speed, transpose, files: result, usedAt: now() }))
    await rm(finalDir, { recursive: true, force: true })
    await rename(partialDir, finalDir)
    await prune(sessionDir, name)
    return result
  }

  return {
    // Resolves with { trackId: path in the session folder } for this speed and key,
    // rendering first if needed. A new request for the session cancels the one
    // in progress (which rejects with RenderCancelledError).
    prepare(sessionId, files, speed, transpose) {
      const current = active.get(sessionId)
      if (isOriginal(speed, transpose)) {
        current?.controller.abort()
        return Promise.resolve(Object.fromEntries(renderPlan(files, 1, 0).map((t) => [t.id, t.output])))
      }
      const name = renderName(speed, transpose)
      if (current?.name === name) return current.promise
      current?.controller.abort()

      const controller = new AbortController()
      const entry = { name, controller }
      entry.promise = render(sessionId, files, speed, transpose, controller.signal).finally(() => {
        if (active.get(sessionId) === entry) active.delete(sessionId)
      })
      active.set(sessionId, entry)
      return entry.promise
    },

    // Stops the session's render, if any. Resolves once it has finished cleaning up.
    async cancel(sessionId) {
      const current = active.get(sessionId)
      if (!current) return
      current.controller.abort()
      await current.promise.catch(() => {})
    },

    cancelAll() {
      for (const { controller } of active.values()) controller.abort()
    },
  }
}
