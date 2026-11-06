import { describe, expect, it } from 'vitest'
import { encodeWav, exportFileName, exportRanges } from './export.js'

describe('exportRanges', () => {
  it('offers where you played (earliest take start to latest end), the loop and the whole song', () => {
    const takes = [{ start: 12, duration: 30 }, { start: 20, duration: 40 }]
    expect(exportRanges({ takes, loop: { start: 33, end: 41 }, duration: 200 })).toEqual([
      { value: 'played', label: 'Where you played', start: 12, end: 60, detail: '0:12–1:00' },
      { value: 'loop', label: 'Loop', start: 33, end: 41, detail: '0:33–0:41' },
      { value: 'song', label: 'Whole song', start: 0, end: 200, detail: '0:00–3:20' },
    ])
  })

  it('keeps where you played inside the song', () => {
    const [played] = exportRanges({ takes: [{ start: -0.06, duration: 300 }], loop: null, duration: 200 })
    expect([played.start, played.end]).toEqual([0, 200])
  })

  it('only offers what exists', () => {
    expect(exportRanges({ takes: [], loop: null, duration: 100 }).map((r) => r.value)).toEqual(['song'])
  })
})

describe('exportFileName', () => {
  it('names the file after the song and the range', () => {
    expect(exportFileName('Center', 'played')).toBe('Center (take).wav')
    expect(exportFileName('Center', 'loop')).toBe('Center (loop).wav')
    expect(exportFileName('AC/DC: Live?', 'song')).toBe('AC-DC- Live-.wav')
    expect(exportFileName('', 'song')).toBe('Resonant.wav')
  })
})

describe('encodeWav', () => {
  const buffer = {
    numberOfChannels: 2,
    length: 3,
    sampleRate: 44100,
    getChannelData: (c) => Float32Array.from(c === 0 ? [0, 1, -1] : [0.5, -0.5, 2]),
  }

  it('writes a 16-bit stereo WAV, clipping out-of-range samples', () => {
    const view = new DataView(encodeWav(buffer, () => 0.5)) // no dither
    const text = (at) => String.fromCharCode(...new Uint8Array(view.buffer, at, 4))
    expect([text(0), text(8), text(36)]).toEqual(['RIFF', 'WAVE', 'data'])
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)]).toEqual([2, 44100, 16, 12])
    const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))
    expect(samples).toEqual([0, 16384, 32767, -16383, -32767, 32767]) // ±16383.5 rounds up
  })

  it('dithers by at most a step either way', () => {
    let n = 0
    const random = () => [0.9, 0.1][n++ % 2]
    const view = new DataView(encodeWav({ ...buffer, numberOfChannels: 1, length: 1 }, random))
    expect(view.getInt16(44, true)).toBe(1)
  })
})
