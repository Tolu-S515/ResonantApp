import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSession, listSessions, readSession, updateSession } from './sessions.js'

// Each test gets its own temp folder holding a fake song and an empty sessions dir,
// so nothing touches the real Application Support folder.
let root
let sessionsDir
let songPath
const songBytes = Buffer.from('RIFF fake wav data')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resonant-test-'))
  sessionsDir = join(root, 'sessions')
  songPath = join(root, 'My Song.wav')
  await writeFile(songPath, songBytes)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const sessionFolders = async () => readdir(sessionsDir).catch(() => [])

describe('createSession', () => {
  it('creates a session folder with the copied song and session.json', async () => {
    const session = await createSession(sessionsDir, songPath)

    const files = await readdir(join(sessionsDir, session.id))
    expect(files.sort()).toEqual(['original.wav', 'session.json'])
    expect(await readFile(join(sessionsDir, session.id, 'original.wav'))).toEqual(songBytes)
  })

  it('writes session.json matching the returned session', async () => {
    const session = await createSession(sessionsDir, songPath)

    const saved = JSON.parse(await readFile(join(sessionsDir, session.id, 'session.json'), 'utf8'))
    expect(saved).toEqual(session)
    expect(saved).toMatchObject({
      status: 'imported',
      source: { fileName: 'My Song.wav', sizeBytes: songBytes.length },
      files: { original: 'original.wav' },
      songName: null,
      artist: null,
      timeSignature: '4/4',
      analysis: null,
    })
    expect(new Date(saved.createdAt).toString()).not.toBe('Invalid Date')
  })

  it('leaves the original file where it was, unchanged', async () => {
    await createSession(sessionsDir, songPath)
    expect(await readFile(songPath)).toEqual(songBytes)
  })

  it('lowercases the extension of the copy', async () => {
    const upper = join(root, 'LOUD.MP3')
    await writeFile(upper, songBytes)

    const session = await createSession(sessionsDir, upper)
    expect(session.files.original).toBe('original.mp3')
    expect(session.source.fileName).toBe('LOUD.MP3')
  })

  it('gives every import its own session', async () => {
    const a = await createSession(sessionsDir, songPath)
    const b = await createSession(sessionsDir, songPath)
    expect(a.id).not.toBe(b.id)
    expect((await sessionFolders()).length).toBe(2)
  })

  it('does not leave a temp file behind after writing session.json', async () => {
    const session = await createSession(sessionsDir, songPath)
    const files = await readdir(join(sessionsDir, session.id))
    expect(files).not.toContain('session.json.tmp')
  })

  describe('rejects bad input without creating a session', () => {
    it('unsupported file type', async () => {
      const txt = join(root, 'notes.txt')
      await writeFile(txt, 'hello')
      await expect(createSession(sessionsDir, txt)).rejects.toThrow('Not a supported audio file')
      expect(await sessionFolders()).toEqual([])
    })

    it('missing file', async () => {
      await expect(createSession(sessionsDir, join(root, 'gone.wav'))).rejects.toThrow()
      expect(await sessionFolders()).toEqual([])
    })

    it('a folder named like an audio file', async () => {
      const dir = join(root, 'album.wav')
      await mkdir(dir)
      await expect(createSession(sessionsDir, dir)).rejects.toThrow('Not a file')
      expect(await sessionFolders()).toEqual([])
    })

    it.each([undefined, null, 42, {}])('non-string path: %s', async (bad) => {
      await expect(createSession(sessionsDir, bad)).rejects.toThrow('Not a supported audio file')
      expect(await sessionFolders()).toEqual([])
    })
  })

  it('removes the half-created session folder if the copy fails', async () => {
    // Unreadable file: stat() succeeds but copyFile() fails after the folder exists
    await chmod(songPath, 0o000)
    try {
      await expect(createSession(sessionsDir, songPath)).rejects.toThrow()
      expect(await sessionFolders()).toEqual([])
    } finally {
      await chmod(songPath, 0o644)
    }
  })
})

describe('updateSession', () => {
  it('merges changes into session.json and returns the new session', async () => {
    const created = await createSession(sessionsDir, songPath)

    const updated = await updateSession(sessionsDir, created.id, {
      status: 'analyzed',
      analysis: { bpm: 120 },
    })

    expect(updated).toEqual({ ...created, status: 'analyzed', analysis: { bpm: 120 } })
    expect(await readSession(sessionsDir, created.id)).toEqual(updated)
  })

  it('keeps earlier changes across multiple updates', async () => {
    const { id } = await createSession(sessionsDir, songPath)
    await updateSession(sessionsDir, id, { status: 'normalizing' })
    await updateSession(sessionsDir, id, { analysis: { bpm: 90 } })

    expect(await readSession(sessionsDir, id)).toMatchObject({
      status: 'normalizing',
      analysis: { bpm: 90 },
    })
  })

  it('rejects for a session that does not exist', async () => {
    await expect(updateSession(sessionsDir, 'missing-id', { status: 'x' })).rejects.toThrow()
  })

  it('applies concurrent updates one after another, losing none', async () => {
    const { id } = await createSession(sessionsDir, songPath)
    await Promise.all([
      updateSession(sessionsDir, id, { status: 'separating', progress: 10 }),
      updateSession(sessionsDir, id, { songName: 'War Cry' }),
      updateSession(sessionsDir, id, { progress: 20 }),
      updateSession(sessionsDir, id, { artist: 'The Belonging Co' }),
    ])
    expect(await readSession(sessionsDir, id)).toMatchObject({
      status: 'separating',
      progress: 20,
      songName: 'War Cry',
      artist: 'The Belonging Co',
    })
  })

  it('keeps working after a failed update', async () => {
    const { id } = await createSession(sessionsDir, songPath)
    const failing = updateSession(sessionsDir, 'missing-id', { status: 'x' })
    await expect(failing).rejects.toThrow()
    await expect(updateSession(sessionsDir, id, { status: 'ok' })).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('listSessions', () => {
  it('returns an empty list before anything is imported', async () => {
    expect(await listSessions(sessionsDir)).toEqual([])
  })

  it('lists sessions newest first', async () => {
    const first = await createSession(sessionsDir, songPath)
    const second = await createSession(sessionsDir, songPath)
    // createdAt can tie within a millisecond; make the order explicit
    await updateSession(sessionsDir, first.id, { createdAt: '2026-01-01T00:00:00.000Z' })
    await updateSession(sessionsDir, second.id, { createdAt: '2026-02-01T00:00:00.000Z' })

    const ids = (await listSessions(sessionsDir)).map((s) => s.id)
    expect(ids).toEqual([second.id, first.id])
  })

  it('skips folders that are not readable sessions', async () => {
    const session = await createSession(sessionsDir, songPath)
    await mkdir(join(sessionsDir, 'not-a-session'))
    await writeFile(join(sessionsDir, '.DS_Store'), '')
    const corrupt = '00000000-0000-4000-8000-000000000000'
    await mkdir(join(sessionsDir, corrupt))
    await writeFile(join(sessionsDir, corrupt, 'session.json'), '{ not json')
    const empty = '00000000-0000-4000-8000-000000000001'
    await mkdir(join(sessionsDir, empty))

    expect((await listSessions(sessionsDir)).map((s) => s.id)).toEqual([session.id])
  })
})
