import { useEffect, useState } from 'react'

// The native engine's state, kept up to date: { settings, info, error }, or null while loading.
// settings: { inputUid, outputUid, name, bufferFrames }. info is set while audio is on.
export function useAudioState() {
  const [state, setState] = useState(null)
  useEffect(() => {
    let cancelled = false
    let pushed = false
    const unsubscribe = window.resonant.audio.onState((next) => {
      pushed = true
      setState(next)
    })
    // A pushed state is newer than this initial read, so it wins
    window.resonant.audio.getState().then((initial) => !cancelled && !pushed && setState(initial))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return state
}

// Input peaks while audio is on: { tracks: [{ index, left, right }], inputs: [peak per channel] }
export function useAudioMeters() {
  const [meters, setMeters] = useState({ tracks: [], inputs: [] })
  useEffect(() => window.resonant.audio.onMeters(setMeters), [])
  return meters
}

// Calls `callback` when audio devices are plugged in or out
export function useDeviceChange(callback) {
  useEffect(() => {
    const devices = navigator.mediaDevices
    if (!devices) return
    devices.addEventListener('devicechange', callback)
    return () => devices.removeEventListener('devicechange', callback)
  }, [callback])
}
