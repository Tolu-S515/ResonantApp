import eighthUrl from '../assets/clicks/eighth.wav'
import quarterUrl from '../assets/clicks/quarter.wav'
import sixteenthUrl from '../assets/clicks/sixteenth.wav'

// Renders the whole click track for a song into one AudioBuffer, ahead of time.
// The engine then plays it like any other track, so it stays locked to the
// stems through play, pause and seek with no scheduling of its own.
//
// Clicks are mixed by copying samples, not through an OfflineAudioContext: an
// offline graph with one source node per click processes every node on every
// render block, which took ~5 s for a 4-minute song (~24 s with 16ths).

const SOUND_URLS = { quarter: quarterUrl, eighth: eighthUrl, sixteenth: sixteenthUrl }
const SAMPLE_RATE = 44100

// Decoded once and reused, as raw samples at SAMPLE_RATE
let soundsPromise = null

function loadSounds() {
  soundsPromise ??= (async () => {
    // Decoding through a 44.1k context also resamples, should a file ever differ
    const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE)
    const entries = await Promise.all(
      Object.entries(SOUND_URLS).map(async ([name, url]) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Could not load click sound "${name}"`)
        const buffer = await decoder.decodeAudioData(await response.arrayBuffer())
        return [name, buffer.getChannelData(0)]
      }),
    )
    return Object.fromEntries(entries)
  })().catch((err) => {
    soundsPromise = null // allow a retry
    throw err
  })
  return soundsPromise
}

// Adds each click's samples into a silent track of `length` samples, starting at
// the sample nearest its time. Overlapping clicks sum. Pure, for testing.
export function mixClicks(events, sounds, sampleRate, length) {
  const out = new Float32Array(length)
  for (const { time, sound } of events) {
    const start = Math.round(time * sampleRate)
    const samples = sounds[sound]
    if (!samples || start < 0 || start >= length) continue
    const end = Math.min(length, start + samples.length)
    for (let i = start; i < end; i++) out[i] += samples[i - start]
  }
  return out
}

// events: [{ time, sound }] from clickEvents(); duration: song length in seconds
export async function renderClickTrack(events, duration) {
  const sounds = await loadSounds()
  const length = Math.max(1, Math.ceil(duration * SAMPLE_RATE))
  const buffer = new AudioBuffer({ length, sampleRate: SAMPLE_RATE, numberOfChannels: 1 })
  buffer.copyToChannel(mixClicks(events, sounds, SAMPLE_RATE, length), 0)
  return buffer
}
