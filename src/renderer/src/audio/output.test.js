import { describe, expect, it } from 'vitest'
import { matchOutputDevice } from './output.js'

const devices = [
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - USB AUDIO  CODEC' },
  { kind: 'audioinput', deviceId: 'in-1', label: 'USB AUDIO  CODEC' },
  { kind: 'audiooutput', deviceId: 'speakers', label: 'MacBook Pro Speakers (Built-in)' },
  { kind: 'audiooutput', deviceId: 'codec', label: 'USB AUDIO CODEC (08bb:2902)' },
]

describe('matchOutputDevice', () => {
  it('finds the output by name, ignoring spacing, case and extra detail', () => {
    expect(matchOutputDevice(devices, 'USB AUDIO  CODEC')).toBe('codec')
    expect(matchOutputDevice(devices, 'macbook pro speakers')).toBe('speakers')
  })

  it('never picks the "default" alias or an input', () => {
    expect(matchOutputDevice(devices.slice(0, 2), 'USB AUDIO  CODEC')).toBeNull()
  })

  it('returns null with no name or no match', () => {
    expect(matchOutputDevice(devices, null)).toBeNull()
    expect(matchOutputDevice(devices, 'Scarlett')).toBeNull()
  })
})
