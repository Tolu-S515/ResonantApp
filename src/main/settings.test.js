import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, readSettings, updateSettings } from './settings.js'

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resonant-settings-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('settings', () => {
  it('returns defaults on first run', async () => {
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })

  it('saves and merges a section', async () => {
    await updateSettings(dir, 'audio', { inputUid: 'in', outputUid: 'out' })
    await updateSettings(dir, 'audio', { bufferFrames: 128 })
    expect((await readSettings(dir)).audio).toEqual({ inputUid: 'in', outputUid: 'out', name: null, bufferFrames: 128 })
  })

  it('keeps every change when updates overlap', async () => {
    await Promise.all([
      updateSettings(dir, 'audio', { inputUid: 'in' }),
      updateSettings(dir, 'audio', { outputUid: 'out' }),
      updateSettings(dir, 'audio', { name: 'Interface' }),
    ])
    expect((await readSettings(dir)).audio).toMatchObject({ inputUid: 'in', outputUid: 'out', name: 'Interface' })
  })

  it('falls back to defaults when the file is corrupt', async () => {
    await writeFile(join(dir, 'settings.json'), '{not json')
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })
})
