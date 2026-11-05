import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_TRACKS, engineTrack } from '../../../shared/audio-settings.js'
import { applyInputOption, newInstrument, removeTrack } from './instruments.js'

const SAVE_DELAY_MS = 400
const saved = ({ inputs, gain, pan }) => ({ inputs, gain, pan })
const ignore = () => {} // the engine reports its own problems through audio state

// The instrument tracks for the player: [{ inputs, gain, pan, monitor, armed }], or
// null while loading. Track i is engine track i. Monitoring and record arm start off,
// and every track stops monitoring when the player closes. Inputs/gain/pan are saved app-wide.
export function useInstruments() {
  const [instruments, setInstruments] = useState(null)
  const sentRef = useRef([]) // what the engine was last told, per index

  useEffect(() => {
    let cancelled = false
    window.resonant.audio.getInstruments().then(
      (list) => !cancelled && setInstruments(list.map((t) => ({ ...t, monitor: false, armed: false }))),
      () => !cancelled && setInstruments([{ inputs: [0], gain: 1, pan: 0, monitor: false, armed: false }]),
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Tell the engine about tracks that changed, and clear ones that were removed
  useEffect(() => {
    if (!instruments) return
    const sent = sentRef.current
    instruments.forEach((track, index) => {
      const settings = engineTrack(track, track.monitor)
      if (JSON.stringify(sent[index]) === JSON.stringify(settings)) return
      sent[index] = settings
      window.resonant.audio.setTrack(index, settings).catch(ignore)
    })
    for (let index = instruments.length; index < sent.length; index++) {
      if (sent[index]) window.resonant.audio.clearTrack(index).catch(ignore)
    }
    sent.length = instruments.length
  }, [instruments])

  // Leaving the player: stop monitoring
  useEffect(
    () => () => {
      sentRef.current.forEach((settings, index) => settings && window.resonant.audio.clearTrack(index).catch(ignore))
      sentRef.current = []
    },
    [],
  )

  // Save shortly after the last change (a gain drag is many changes)
  const toSave = instruments && JSON.stringify(instruments.map(saved))
  const lastSaved = useRef(null)
  useEffect(() => {
    if (!toSave) return
    if (lastSaved.current === null) {
      lastSaved.current = toSave // what was just loaded
      return
    }
    if (toSave === lastSaved.current) return
    const timer = setTimeout(() => {
      lastSaved.current = toSave
      window.resonant.audio.saveInstruments(JSON.parse(toSave)).catch(ignore)
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [toSave])

  const update = useCallback((index, changes) => {
    setInstruments((list) => list.map((t, i) => (i === index ? { ...t, ...changes } : t)))
  }, [])

  // Adds a track on the free input (In 1 → the new one gets In 2), if there is one
  const add = useCallback((channelCount) => {
    setInstruments((list) => {
      const track = list.length < MAX_TRACKS && newInstrument(list, channelCount)
      return track ? [...list, { ...track, monitor: false, armed: false }] : list
    })
  }, [])

  // value: from inputOptions()
  const setInputs = useCallback((index, value) => {
    setInstruments((list) => applyInputOption(list, index, value))
  }, [])

  const remove = useCallback((index) => {
    setInstruments((list) => removeTrack(list, index))
  }, [])

  return { instruments, update, setInputs, add, remove }
}
