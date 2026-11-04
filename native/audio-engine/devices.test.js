import { describe, expect, it } from 'vitest'
import { findInterface, listInterfaces } from './devices.js'

const device = (uid, name, inputChannels, outputChannels, extra = {}) => ({
  uid,
  name,
  inputChannels,
  outputChannels,
  sampleRate: 44100,
  clockDomain: 0,
  ...extra,
})

// As the user's Burr-Brown interface shows up: output half ":1", input half ":2"
const codecOut = device('AppleUSBAudioEngine:BurrBrown from Texas Instruments:USB AUDIO  CODEC:14430000:1', 'USB AUDIO  CODEC', 0, 2)
const codecIn = device('AppleUSBAudioEngine:BurrBrown from Texas Instruments:USB AUDIO  CODEC:14430000:2', 'USB AUDIO  CODEC', 2, 0)
const mic = device('BuiltInMicrophoneDevice', 'MacBook Pro Microphone', 1, 0)
const speakers = device('BuiltInSpeakerDevice', 'MacBook Pro Speakers', 0, 2)
const scarlett = device('AppleUSBAudioEngine:Focusrite:Scarlett 2i2 USB:1', 'Scarlett 2i2 USB', 2, 2)

describe('listInterfaces', () => {
  it('pairs an interface that macOS splits into input and output devices', () => {
    expect(listInterfaces([codecOut, codecIn])).toEqual([
      {
        name: 'USB AUDIO  CODEC',
        inputUid: codecIn.uid,
        outputUid: codecOut.uid,
        inputChannels: 2,
        outputChannels: 2,
        sampleRate: 44100,
        split: true,
      },
    ])
  })

  it('uses one device for an interface with inputs and outputs', () => {
    const [found] = listInterfaces([scarlett])
    expect(found).toMatchObject({ inputUid: scarlett.uid, outputUid: scarlett.uid, split: false })
  })

  it('prefers a matching clock domain when one is reported', () => {
    const input = device('A:in', 'Interface', 2, 0, { clockDomain: 7 })
    const wrong = device('B:out', 'Interface', 0, 2, { clockDomain: 9 })
    const right = device('C:out', 'Other name', 0, 2, { clockDomain: 7 })
    expect(listInterfaces([input, wrong, right])[0].outputUid).toBe('C:out')
  })

  it('never pairs the built-in mic with the built-in speakers', () => {
    expect(listInterfaces([mic, speakers])).toEqual([])
  })

  it('skips input-only devices with no output to monitor on', () => {
    expect(listInterfaces([codecIn])).toEqual([])
  })
})

describe('findInterface', () => {
  const devices = [mic, speakers, codecOut, codecIn, scarlett]

  it('finds by part of the name, ignoring case', () => {
    expect(findInterface(devices, 'usb audio').outputUid).toBe(codecOut.uid)
    expect(findInterface(devices, 'scarlett').inputUid).toBe(scarlett.uid)
  })

  it('finds by input uid', () => {
    expect(findInterface(devices, codecIn.uid).name).toBe('USB AUDIO  CODEC')
  })

  it('returns undefined when nothing matches', () => {
    expect(findInterface(devices, 'nope')).toBeUndefined()
  })
})
