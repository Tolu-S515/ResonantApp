// Export: what you hear, rendered to a WAV file. Same tracks, levels and limiter
// as playback (see engine.js), always at 100% speed (takes are recorded at 100%),
// over one of a few ranges the app already knows.
import { formatTime } from '../format.js'
import { MUSIC_BUS_DB, createLimiter } from './engine.js'

const SAMPLE_RATE = 44100
// Fade in and out at the cut points, so a section doesn't start or end with a click
export const EXPORT_FADE = 0.01
// The limiter's look-ahead delays what comes out of it by this much (Chromium's
// compressor, measured: 264 frames at 44.1 kHz). Sources start this much early to
// make up for it, so the file starts exactly at the range's start.
const LIMITER_DELAY = Math.floor(0.006 * SAMPLE_RATE) / SAMPLE_RATE

// The ranges on offer, in song seconds: where you played (from the earliest take's
// start to the latest one's end; only if there are takes), the loop (only while
// looping) and the whole song. takes: the active takes.
export function exportRanges({ takes, loop, duration }) {
  const ranges = []
  if (takes.length > 0) {
    const start = Math.max(0, Math.min(...takes.map((t) => t.start)))
    const end = Math.min(duration, Math.max(...takes.map((t) => t.start + t.duration)))
    if (end > start) ranges.push({ value: 'played', label: 'Where you played', start, end })
  }
  if (loop) ranges.push({ value: 'loop', label: 'Loop', start: loop.start, end: Math.min(loop.end, duration) })
  ranges.push({ value: 'song', label: 'Whole song', start: 0, end: duration })
  return ranges.map((r) => ({ ...r, detail: `${formatTime(r.start)}–${formatTime(r.end)}` }))
}

// "Center (take).wav": the song's name and the range, safe as a file name
export function exportFileName(title, range) {
  const suffix = { played: ' (take)', loop: ' (loop)', song: '' }[range] ?? ''
  const safe = (title || 'Resonant').replace(/[/\\:*?"<>|]+/g, '-').trim()
  return `${safe}${suffix}.wav`
}

// Renders the mix of `range` ({ start, end } song seconds) into a stereo AudioBuffer.
// song: [{ buffer, gain }] (start at song time 0). clips: [{ buffer, start, gain }].
// click: { buffer, gain } or null. backing: the Song level (song and click, not clips).
export async function renderMix({ song, clips, click, backing, range }) {
  const length = Math.max(1, Math.round((range.end - range.start) * SAMPLE_RATE))
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE)
  const seconds = length / SAMPLE_RATE

  // Everything → limiter → fades (after it, so its delay can't push sound past them)
  const out = ctx.createGain()
  const limiter = createLimiter(ctx)
  const fade = ctx.createGain()
  out.connect(limiter)
  limiter.connect(fade)
  fade.connect(ctx.destination)
  const last = (length - 1) / SAMPLE_RATE // the final frame lands on silence
  fade.gain.setValueAtTime(0, 0)
  fade.gain.linearRampToValueAtTime(1, Math.min(EXPORT_FADE, last / 2))
  fade.gain.setValueAtTime(1, Math.max(last / 2, last - EXPORT_FADE))
  fade.gain.linearRampToValueAtTime(0, last)

  const bus = (gain) => {
    const node = ctx.createGain()
    node.gain.value = gain
    node.connect(out)
    return node
  }
  const musicBus = bus(10 ** (MUSIC_BUS_DB / 20) * backing)
  const clipBus = bus(1)
  const clickBus = bus(backing)

  // Plays `buffer` placed at song time `start` through a gain into `destination`.
  // Offline time 0 plays song time `from` into the limiter (see LIMITER_DELAY).
  const from = range.start + LIMITER_DELAY
  function place(buffer, start, gain, destination) {
    if (!buffer || gain <= 0 || start >= from + seconds || start + buffer.duration <= from) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const level = ctx.createGain()
    level.gain.value = gain
    source.connect(level)
    level.connect(destination)
    if (start >= from) source.start(start - from)
    else source.start(0, from - start)
  }
  for (const t of song) place(t.buffer, 0, t.gain, musicBus)
  for (const c of clips) place(c.buffer, c.start, c.gain, clipBus)
  if (click) place(click.buffer, 0, click.gain, clickBus)
  return ctx.startRendering()
}

// 16-bit PCM WAV of an AudioBuffer, with TPDF dither (so quiet fades don't turn to
// grit when the 32-bit floats are rounded). random: for tests.
export function encodeWav(buffer, random = Math.random) {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const dataBytes = frames * channels * 2
  const bytes = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(bytes)
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let at = 44
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const dithered = data[c][f] * 32767 + (random() - random())
      view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(dithered))), true)
      at += 2
    }
  }
  return bytes
}
