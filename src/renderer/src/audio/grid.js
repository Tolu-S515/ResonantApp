// Beat grid and click events, built from the beats found by analysis.
//
// Most recorded music is played to a click, so its true beat grid is perfectly
// even. Essentia's beats are reliable in busy sections but can wander in sparse
// ones (intros, breakdowns); in one test song it tracked the intro at 139.7 BPM
// against a true 147.67. So the grid's tempo and phase come only from the
// reliable stretches, then extend over the whole song, intro and breakdowns
// included. Songs whose reliable stretches disagree (a real tempo change, no
// click) keep their detected beats instead.

// A beat is "reliable" when the gaps around it agree with each other this closely
const STABLE_TOLERANCE = 0.03
// How many gaps on each side of a beat are compared
const STABLE_NEIGHBOURS = 4
// Reliable beats at the song's main tempo may sit at most this far (RMS, seconds)
// off one straight grid...
export const STEADY_TOLERANCE = 0.02
// ...must cover at least this share of the song's beats...
const MIN_MAIN_FRACTION = 0.3
// ...and reliable beats at some *other* tempo may cover at most this share.
// A short wrong-tempo stretch is a detection error; a long one is a real tempo change.
const MAX_OTHER_TEMPO_FRACTION = 0.25
// A reliable beat is at the main tempo if its local gap is this close to it
const SAME_TEMPO_TOLERANCE = 0.015
// Beats further than this off the fitted grid are left out of the final fit
const OUTLIER_SECONDS = 0.035
const MIN_BEATS_TO_FIT = 8

// Beats per bar, and how many clicks per beat each subdivision adds.
// 6/8: the beat tracker follows the dotted-quarter pulse, so 2 beats per bar
// with three eighths in each.
export const METERS = {
  '4/4': { beatsPerBar: 4, perBeat: { off: 1, eighth: 2, sixteenth: 4 } },
  '3/4': { beatsPerBar: 3, perBeat: { off: 1, eighth: 2, sixteenth: 4 } },
  '6/8': { beatsPerBar: 2, perBeat: { off: 1, eighth: 3, sixteenth: 6 } },
}

export const SUBDIVISIONS = ['off', 'eighth', 'sixteenth']

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Least-squares line y = offset + period * x
function fitLine(points) {
  const n = points.length
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n
  let sxy = 0
  let sxx = 0
  for (const [x, y] of points) {
    sxy += (x - meanX) * (y - meanY)
    sxx += (x - meanX) ** 2
  }
  const period = sxy / sxx
  return { period, offset: meanY - period * meanX }
}

// Reliable beats: those whose surrounding gaps all agree with their local median.
// Returns [{ index, gap }], gap being that local median (the local beat length).
export function stableBeats(beats) {
  const gaps = beats.slice(1).map((t, i) => t - beats[i])
  const stable = []
  for (let i = STABLE_NEIGHBOURS; i < beats.length - STABLE_NEIGHBOURS; i++) {
    const around = gaps.slice(i - STABLE_NEIGHBOURS, i + STABLE_NEIGHBOURS)
    const gap = median(around)
    if (gap > 0 && around.every((g) => Math.abs(g / gap - 1) <= STABLE_TOLERANCE)) stable.push({ index: i, gap })
  }
  return stable
}

// Grid number of each time against a fit, and how far off the grid it is
function gridResidual(t, fit) {
  const n = Math.round((t - fit.offset) / fit.period)
  return { n, residual: t - (fit.offset + n * fit.period) }
}

// Fits one steady tempo, time = offset + period * n, to the song's reliable beats.
//
// 1. Find reliable beats and the song's main tempo (the median of their local tempos).
// 2. Fit only the reliable beats at that tempo. Grid numbers come from rounding
//    against the current fit, starting from the beats nearest the middle and
//    widening step by step, so a slightly-off first tempo can't miscount distant beats.
// 3. Refit without the beats that landed far off the grid.
//
// Returns the fit plus what share of beats it rests on, and what share were
// reliable but at a different tempo; beatGrid decides from those.
export function fitSteadyTempo(beats) {
  if (beats.length < MIN_BEATS_TO_FIT) return null
  const stable = stableBeats(beats)
  if (stable.length < MIN_BEATS_TO_FIT) return null

  const mainGap = median(stable.map((b) => b.gap))
  const atMainTempo = stable.filter((b) => Math.abs(b.gap / mainGap - 1) <= SAME_TEMPO_TOLERANCE)
  const otherTempo = stable.filter((b) => Math.abs(b.gap / mainGap - 1) > STABLE_TOLERANCE)
  if (atMainTempo.length < MIN_BEATS_TO_FIT) return null
  let times = atMainTempo.map((b) => beats[b.index])

  const anchor = times[Math.floor(times.length / 2)]
  let fit = { period: mainGap, offset: anchor }
  const span = Math.max(anchor - times[0], times.at(-1) - anchor)
  for (let radius = 20; ; radius *= 2) {
    const near = times.filter((t) => Math.abs(t - anchor) <= radius)
    if (near.length >= 2) fit = fitLine(near.map((t) => [gridResidual(t, fit).n, t]))
    if (radius >= span) break
  }

  times = times.filter((t) => Math.abs(gridResidual(t, fit).residual) <= OUTLIER_SECONDS)
  if (times.length < MIN_BEATS_TO_FIT) return null
  fit = fitLine(times.map((t) => [gridResidual(t, fit).n, t]))

  const residuals = times.map((t) => gridResidual(t, fit).residual)
  const rms = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length)
  return {
    ...fit,
    rms,
    mainFraction: times.length / beats.length,
    otherTempoFraction: otherTempo.length / beats.length,
  }
}

export function isSteady(fit) {
  return (
    fit !== null &&
    fit.rms <= STEADY_TOLERANCE &&
    fit.mainFraction >= MIN_MAIN_FRACTION &&
    fit.otherTempoFraction <= MAX_OTHER_TEMPO_FRACTION
  )
}

// The beat times to click on. For a steady song: one even grid from the start
// of the song to the end. Otherwise: the detected beats.
export function beatGrid(beats, duration) {
  const fit = fitSteadyTempo(beats)
  if (!isSteady(fit)) {
    return { steady: false, beats: beats.filter((t) => t <= duration) }
  }

  // offset + i * period (not a running sum) so rounding error can't build up over a long song
  const grid = []
  for (let i = Math.ceil(-fit.offset / fit.period); ; i++) {
    const time = fit.offset + i * fit.period
    if (time > duration) break
    if (time >= 0) grid.push(time)
  }
  return { steady: true, beats: grid, bpm: 60 / fit.period }
}

// Whether beat `index` starts a bar. barShift moves bar starts later by that many beats.
export function isBarStart(index, beatsPerBar, barShift = 0) {
  return (((index - barShift) % beatsPerBar) + beatsPerBar) % beatsPerBar === 0
}

// Which sound file plays for each kind of click
export const CLICK_SOUNDS = {
  accent: 'quarter',
  normal: 'eighth',
}

// Every click to play: { time, sound }, sound being a file from CLICK_SOUNDS.
//
// Subdivisions split each beat evenly, so they follow the beats' real timing.
// Accents are counted in clicks, starting on the first beat of a bar:
// - Beats: one every beatsPerBar clicks (Accent-2-3-4 in 4/4), i.e. each bar.
// - 8ths: one every bar's worth of eighths (Accent-2-3-4-5-6-7-8 in 4/4).
// - 16ths: one every beatsPerBar clicks (each beat in 4/4).
// All other clicks use the normal sound. barShift moves bar starts later by that many beats.
export function clickEvents(beats, { timeSignature = '4/4', subdivision = 'off', barShift = 0 } = {}) {
  const meter = METERS[timeSignature] ?? METERS['4/4']
  const perBeat = meter.perBeat[subdivision] ?? 1
  const accentEvery = subdivision === 'eighth' ? meter.beatsPerBar * perBeat : meter.beatsPerBar
  const sound = (clickNumber) => CLICK_SOUNDS[isBarStart(clickNumber, accentEvery) ? 'accent' : 'normal']

  const events = []
  beats.forEach((time, i) => {
    // Click count from the first bar start, so accents line up with bar starts
    const first = (i - barShift) * perBeat
    events.push({ time, sound: sound(first) })
    if (perBeat === 1) return
    // The last beat has no next beat; reuse the previous gap
    const next = beats[i + 1] ?? (i > 0 ? time + (time - beats[i - 1]) : null)
    if (next === null) return
    const step = (next - time) / perBeat
    for (let k = 1; k < perBeat; k++) events.push({ time: time + k * step, sound: sound(first + k) })
  })
  return events
}

// Bar start times, for drawing bar lines and numbers
export function barStarts(beats, { timeSignature = '4/4', barShift = 0 } = {}) {
  const { beatsPerBar } = METERS[timeSignature] ?? METERS['4/4']
  return beats.filter((_, i) => isBarStart(i, beatsPerBar, barShift))
}

// Every how many items to draw so neighbours are at least minSpacing pixels apart
export function thinningStep(count, width, minSpacing) {
  if (count <= 1 || width <= 0) return 1
  const spacing = width / count
  return spacing >= minSpacing ? 1 : Math.ceil(minSpacing / spacing)
}
