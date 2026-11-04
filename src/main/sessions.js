import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { isAudioFile } from '../shared/audio.js'

/**
 * Session folder layout:
 *
 *   <sessionsDir>/<id>/
 *   ├── session.json
 *   ├── original.<ext>   untouched copy of the user's file (never deleted)
 *   ├── reference.wav    normalized copy, written by processing
 *   ├── stems/           written by processing
 *   ├── peaks/           waveform data, written by processing
 *   └── recordings/      the user's takes (never deleted)
 *
 * reference.wav, stems/ and peaks/ are derived and safe to regenerate.
 */

// Write via a temp file + rename so a crash never leaves a half-written session.json
async function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await rename(tmp, path)
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Session ids are UUIDs; anything else from the renderer is rejected before it reaches a path
export function isSessionId(id) {
  return typeof id === 'string' && SESSION_ID.test(id)
}

export function sessionPath(sessionsDir, id, ...parts) {
  return join(sessionsDir, id, ...parts)
}

export async function readSession(sessionsDir, id) {
  return JSON.parse(await readFile(sessionPath(sessionsDir, id, 'session.json'), 'utf8'))
}

// Every readable session, newest first. Folders that aren't sessions, or whose
// session.json is missing or corrupt, are skipped rather than failing the whole list.
export async function listSessions(sessionsDir) {
  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return [] // nothing imported yet
    throw err
  }
  const ids = entries.filter((e) => e.isDirectory() && isSessionId(e.name)).map((e) => e.name)
  const sessions = await Promise.all(ids.map((id) => readSession(sessionsDir, id).catch(() => null)))
  return sessions.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// Updates to one session run one after another. Main is the only writer of
// session.json, but processing and the details form can both update it at the
// same time; without this, two read-modify-writes could interleave and one
// change would overwrite the other.
const sessionLocks = new Map() // session folder → tail of its update chain

export function updateSession(sessionsDir, id, changes) {
  const key = sessionPath(sessionsDir, id)
  const run = (sessionLocks.get(key) ?? Promise.resolve()).then(async () => {
    const session = { ...(await readSession(sessionsDir, id)), ...changes }
    await writeJsonAtomic(sessionPath(sessionsDir, id, 'session.json'), session)
    return session
  })
  // A failed update must not block the next one
  const tail = run.catch(() => {})
  sessionLocks.set(key, tail)
  tail.then(() => {
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key)
  })
  return run
}

export async function createSession(sessionsDir, sourcePath) {
  // The path comes from the renderer, so validate it before touching anything
  if (typeof sourcePath !== 'string' || !isAudioFile(sourcePath)) {
    throw new Error('Not a supported audio file')
  }
  const info = await stat(sourcePath)
  if (!info.isFile()) throw new Error('Not a file')

  const id = randomUUID()
  const sessionDir = join(sessionsDir, id)
  const originalName = `original${extname(sourcePath).toLowerCase()}`

  try {
    // stems/ and peaks/ are created by processing when it writes them
    await mkdir(sessionDir, { recursive: true })

    // Copy, never move: the user's original stays where it was.
    // COPYFILE_FICLONE makes an instant copy-on-write clone on APFS, with a normal copy as fallback.
    await copyFile(sourcePath, join(sessionDir, originalName), constants.COPYFILE_FICLONE)

    const session = {
      id,
      status: 'imported',
      createdAt: new Date().toISOString(),
      source: { fileName: basename(sourcePath), sizeBytes: info.size },
      files: { original: originalName },
      songName: null,
      artist: null,
      timeSignature: '4/4',
      // Which grid beat is beat 1 of a bar (set in the player)
      barShift: 0,
      analysis: null,
    }
    await writeJsonAtomic(join(sessionDir, 'session.json'), session)
    return session
  } catch (err) {
    // Don't leave a half-created session folder behind
    await rm(sessionDir, { recursive: true, force: true })
    throw err
  }
}
