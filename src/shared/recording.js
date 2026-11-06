// Recording: where a take sits on the song timeline, and the loopback calibration.
//
// Backing tracks play in the page (Web Audio) and the instrument is recorded by the
// native engine, in another process. They share the interface's clock but not a
// timeline, so both are tied to the wall clock (ms since 1970):
// - the engine reports when its first recorded frame reached the driver;
// - the page reports which song time was coming out of the speakers at some moment
//   (a "reference": { epochMs, songTime }).
// What you play lands at the song time you were hearing when you played it, so a
// take starts at the song time heard when its first frame was captured.
//
// The interface's reported input latency covers most of the gap between the sound
// arriving and the driver getting it; the rest (and any error in the page's idea of
// its output latency) is measured once with a loopback cable: the offset.

export const MIN_TAKE_SECONDS = 0.5 // shorter takes (record pressed twice) aren't kept
const MAX_REFERENCE_AGE_MS = 6 * 60 * 60 * 1000

// Song time where the take's first frame belongs.
// startEpochMs: from the engine. inputLatencyMs: as the interface reports it.
// offsetMs: from calibration (0 if not calibrated). speed: playback speed (1 while recording).
export function takeStart({ startEpochMs, reference, inputLatencyMs = 0, offsetMs = 0, speed = 1 }) {
  const capturedAt = startEpochMs - inputLatencyMs + offsetMs
  return reference.songTime + ((capturedAt - reference.epochMs) / 1000) * speed
}

// A reference from the page, checked: { epochMs, songTime }
export function sanitizeReference(input, now = Date.now()) {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid recording reference')
  const { epochMs, songTime } = input
  if (!Number.isFinite(epochMs) || Math.abs(epochMs - now) > MAX_REFERENCE_AGE_MS) throw new Error('Invalid recording reference')
  if (!Number.isFinite(songTime) || songTime < -60 || songTime > 24 * 60 * 60) throw new Error('Invalid recording reference')
  return { epochMs, songTime }
}

// References for each stretch of playback during a recording ("segments": playback
// restarts from the loop start at each loop wrap), checked and sorted
export function sanitizeSegments(input, now = Date.now()) {
  const list = Array.isArray(input) ? input : [input]
  if (list.length === 0 || list.length > 10_000) throw new Error('Invalid recording reference')
  return list.map((r) => sanitizeReference(r, now)).sort((a, b) => a.epochMs - b.epochMs)
}

// Splits a recording made across loop wraps into one take per pass.
// capturedAtMs: when its first frame was played (input latency and offset applied).
// segments: sorted references, one per stretch of playback. Returns
// [{ from, to, start, endsAtWrap }]: frame range, song time of `from`, and whether
// the pass ran to a wrap (rather than being cut short by stopping).
export function takePasses({ frames, sampleRate, capturedAtMs, segments }) {
  const frameAt = (ms) => Math.min(frames, Math.max(0, Math.ceil(((ms - capturedAtMs) / 1000) * sampleRate)))
  const passes = []
  segments.forEach((segment, k) => {
    const from = k === 0 ? 0 : frameAt(segment.epochMs)
    const last = k === segments.length - 1
    const to = last ? frames : frameAt(segments[k + 1].epochMs)
    if (to <= from) return
    const fromMs = capturedAtMs + (from / sampleRate) * 1000
    passes.push({ from, to, start: segment.songTime + (fromMs - segment.epochMs) / 1000, endsAtWrap: !last })
  })
  return passes
}

// The calibration applies to one interface at one buffer size
export const offsetKey = ({ inputUid, outputUid, bufferFrames }) => `${inputUid}|${outputUid}|${bufferFrames}`

// The saved offset if it was measured with these settings, else 0
export function recordOffsetMs(settings) {
  const saved = settings.recordOffset
  return saved && saved.key === offsetKey(settings) && Number.isFinite(saved.ms) ? saved.ms : 0
}

// Calibration pulses in a recording: the first sample of each burst above a
// threshold set from the loudest sample (so the interface's output level doesn't
// matter), at least `gapSeconds` apart. Returns frame indexes.
export function findPulses(samples, sampleRate, { gapSeconds = 0.2, minLevel = 0.01 } = {}) {
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  if (peak < minLevel) return []
  const threshold = peak * 0.3
  const gap = Math.round(gapSeconds * sampleRate)
  const pulses = []
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) < threshold) continue
    pulses.push(i)
    i += gap
  }
  return pulses
}

// The offset that lines measured pulses up with when they were played: the median
// difference over pulses heard within `windowMs` of one that was played. Null if
// fewer than `minPulses` match (no cable, or the output turned down).
export function calibrationOffset(expectedMs, measuredMs, { windowMs = 150, minPulses = 3 } = {}) {
  const diffs = []
  for (const expected of expectedMs) {
    let best = null
    for (const measured of measuredMs) {
      const diff = expected - measured
      if (Math.abs(diff) <= windowMs && (best === null || Math.abs(diff) < Math.abs(best))) best = diff
    }
    if (best !== null) diffs.push(best)
  }
  if (diffs.length < minPulses) return null
  diffs.sort((a, b) => a - b)
  const mid = diffs.length >> 1
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2
}

// Takes on an instrument track, oldest first, numbered from 1
export function takesOnTrack(takes = [], track) {
  return takes.filter((t) => t.track === track).map((t, i) => ({ ...t, number: i + 1 }))
}
