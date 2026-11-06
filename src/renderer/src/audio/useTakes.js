import { useEffect, useRef, useState } from 'react'
import { bufferPeaks } from './peaks.js'

// Mono takes play equally in both speakers, which is 3 dB louder than the
// centre-panned monitoring you heard while playing; this evens it out.
const MONO_GAIN = Math.SQRT1_2

export const clipId = (take) => `take:${take.id}`

// A take's playback level: its instrument track's gain (and the mono evening-out)
export const takeGain = (take, trackGain) => trackGain * (take.channels === 1 ? MONO_GAIN : 1)

// Each instrument track's chosen take, as { [track]: take }
export function activeTakes(session) {
  const takes = session?.takes ?? []
  const active = {}
  for (const [track, id] of Object.entries(session?.activeTakes ?? {})) {
    const take = id && takes.find((t) => t.id === id)
    if (take) active[track] = take
  }
  return active
}

// Plays each instrument track's chosen take in the engine, at its place in the song.
// Takes are loaded once each per engine. A track's take is silent while that track
// is being recorded over. gainFor(track): the instrument track's level.
// Returns { [take id]: peaks } for drawing, filled in as takes load.
export function useTakes({ engineRef, audioKey, audioState, sessionId, session, gainFor, recordingTracks, onError }) {
  const [peaks, setPeaks] = useState({})
  const loaded = useRef({ audioKey: null, ids: new Set() })
  const active = activeTakes(session)
  const activeKey = Object.values(active)
    .map((t) => `${t.id}@${t.start}`)
    .sort()
    .join()

  useEffect(() => {
    const engine = engineRef.current
    if (!engine || audioState !== 'ready') return
    if (loaded.current.audioKey !== audioKey) loaded.current = { audioKey, ids: new Set() }
    const { ids } = loaded.current
    const wanted = new Map(Object.values(active).map((take) => [clipId(take), take]))

    for (const id of ids) {
      if (wanted.has(id)) continue
      engine.removeClip(id)
      ids.delete(id)
    }
    for (const [id, take] of wanted) {
      if (ids.has(id)) continue
      ids.add(id)
      engine
        .decode(`resonant://session/${sessionId}/${take.file}`, 'a take')
        .then((buffer) => {
          // Skip it if the engine was replaced or the take deselected meanwhile
          if (engineRef.current !== engine || !ids.has(id)) return
          engine.setClip(id, buffer, take.start)
          setPeaks((prev) => ({ ...prev, [take.id]: bufferPeaks(buffer) }))
        })
        .catch((err) => {
          ids.delete(id)
          onError(err.message)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `active` is summed up by activeKey
  }, [engineRef, audioKey, audioState, sessionId, activeKey])

  // Levels: the track's gain, and silent while it's being recorded over
  const gainKey = Object.entries(active)
    .map(([track, take]) => `${take.id}:${recordingTracks.includes(Number(track)) ? 0 : gainFor(Number(track))}`)
    .join()
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    for (const [track, take] of Object.entries(active)) {
      const gain = recordingTracks.includes(Number(track)) ? 0 : gainFor(Number(track))
      engine.setGain(clipId(take), takeGain(take, gain))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- summed up by gainKey
  }, [engineRef, gainKey, audioState, peaks])

  return peaks
}
