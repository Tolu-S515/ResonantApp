import { describe, expect, it } from 'vitest'
import { AUDIO_EXTENSIONS, isAudioFile } from './audio.js'

describe('isAudioFile', () => {
  it.each(AUDIO_EXTENSIONS)('accepts .%s', (ext) => {
    expect(isAudioFile(`song.${ext}`)).toBe(true)
  })

  it('ignores case', () => {
    expect(isAudioFile('Song.MP3')).toBe(true)
    expect(isAudioFile('Song.Wav')).toBe(true)
  })

  it('accepts full paths', () => {
    expect(isAudioFile('/Users/me/Music/My Song.mp3')).toBe(true)
  })

  it('uses only the last extension', () => {
    expect(isAudioFile('song.backup.wav')).toBe(true)
    expect(isAudioFile('song.mp3.exe')).toBe(false)
  })

  it('rejects unsupported extensions', () => {
    expect(isAudioFile('notes.txt')).toBe(false)
    expect(isAudioFile('video.mov')).toBe(false)
  })

  it('rejects names without an extension', () => {
    expect(isAudioFile('song')).toBe(false)
    expect(isAudioFile('wav')).toBe(false)
    expect(isAudioFile('/Users/me/Music/mp3')).toBe(false)
  })

  it('rejects a dot inside a folder name rather than the file name', () => {
    expect(isAudioFile('/Users/me/song.wav/notes')).toBe(false)
  })

  it('rejects empty names', () => {
    expect(isAudioFile('')).toBe(false)
    expect(isAudioFile('.')).toBe(false)
  })

  it('treats a leading dot as a hidden file, not an extension', () => {
    expect(isAudioFile('.mp3')).toBe(false)
    expect(isAudioFile('.hidden.wav')).toBe(true)
  })

  it('handles Windows paths', () => {
    expect(isAudioFile('C:\\Users\\me\\Music\\song.flac')).toBe(true)
    expect(isAudioFile('C:\\Users\\me\\song.wav\\notes')).toBe(false)
  })
})
