// App-wide settings (not per session), in userData/settings.json.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_BUFFER_FRAMES, DEFAULT_INSTRUMENTS } from '../shared/audio-settings.js'

const FILE = 'settings.json'

export const DEFAULT_SETTINGS = {
  // The audio interface for monitoring and backing tracks. name is kept for
  // showing it while unplugged and for finding it among Web Audio's outputs.
  audio: { inputUid: null, outputUid: null, name: null, bufferFrames: DEFAULT_BUFFER_FRAMES },
  // Instrument tracks shown in every player (see sanitizeInstruments)
  instruments: { tracks: DEFAULT_INSTRUMENTS },
}

export async function readSettings(dir) {
  let saved = {}
  try {
    saved = JSON.parse(await readFile(join(dir, FILE), 'utf8'))
  } catch (err) {
    // Missing on first run; unreadable means start over rather than refuse to open
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
  }
  return Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).map(([section, defaults]) => [section, { ...defaults, ...saved[section] }]),
  )
}

// Per directory, so concurrent updates apply one after another instead of losing each other
const locks = new Map()

// Merges changes into one section and saves. Returns the whole new settings.
export function updateSettings(dir, section, changes) {
  const previous = locks.get(dir) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const settings = await readSettings(dir)
      settings[section] = { ...settings[section], ...changes }
      await mkdir(dir, { recursive: true })
      // Write then rename, so a crash mid-write can't leave half a file
      const temp = join(dir, `${FILE}.tmp`)
      await writeFile(temp, JSON.stringify(settings, null, 2))
      await rename(temp, join(dir, FILE))
      return settings
    })
  locks.set(dir, next)
  return next
}
