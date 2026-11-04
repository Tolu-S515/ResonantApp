import { describe, expect, it } from 'vitest'
import {
  applyInputOption,
  describeInputs,
  freeInput,
  inputOptions,
  newInstrument,
  optionValue,
  removeTrack,
  trackPeaks,
} from './instruments.js'

const track = (...inputs) => ({ inputs, gain: 1, pan: 0, monitor: false })
const summary = (options) => options.map((o) => `${o.label}${o.disabled ? ' (taken)' : ''}`)

describe('inputOptions', () => {
  it('offers Input 1, Input 2 and Stereo on a 2-input interface', () => {
    expect(summary(inputOptions([track(0)], 0, 2))).toEqual(['Input 1', 'Input 2', 'Stereo'])
  })

  it("disables inputs another track has, and Stereo with them", () => {
    const list = [track(0), track(1)]
    expect(summary(inputOptions(list, 0, 2))).toEqual(['Input 1', 'Input 2 (taken)', 'Stereo (taken)'])
    expect(summary(inputOptions(list, 1, 2))).toEqual(['Input 1 (taken)', 'Input 2', 'Stereo (taken)'])
  })

  it('names the pairs on bigger interfaces', () => {
    expect(summary(inputOptions([track(0)], 0, 4))).toEqual([
      'Input 1',
      'Input 2',
      'Input 3',
      'Input 4',
      'Stereo 1+2',
      'Stereo 3+4',
    ])
  })

  it("keeps a track's input listed while the interface is unplugged", () => {
    expect(inputOptions([track(1)], 0, 1).map((o) => o.value)).toEqual(['input:0', 'input:1'])
  })
})

describe('applyInputOption / optionValue', () => {
  it('switches between mono and stereo', () => {
    expect(applyInputOption([track(0)], 0, 'input:1')).toEqual([track(1)])
    expect(applyInputOption([track(0)], 0, 'stereo:0')).toEqual([track(0, 1)])
    expect(optionValue(track(0, 1))).toBe('stereo:0')
    expect(optionValue(track(1))).toBe('input:1')
  })
})

describe('adding tracks', () => {
  it('gives a new track the other input', () => {
    expect(newInstrument([track(0)], 2).inputs).toEqual([1])
    expect(newInstrument([track(1)], 2).inputs).toEqual([0])
  })

  it("can't add once every input is in use", () => {
    expect(freeInput([track(0, 1)], 2)).toBe(-1)
    expect(newInstrument([track(0, 1)], 2)).toBeNull()
    expect(newInstrument([track(0), track(1)], 2)).toBeNull()
  })
})

describe('removeTrack', () => {
  it('removes added tracks but never the first', () => {
    const list = [track(0), track(1)]
    expect(removeTrack(list, 1)).toEqual([track(0)])
    expect(removeTrack(list, 0)).toBe(list)
  })
})

describe('describeInputs / trackPeaks', () => {
  it('describes inputs', () => {
    expect(describeInputs([1])).toBe('Input 2')
    expect(describeInputs([0, 1])).toBe('Inputs 1+2 (stereo)')
  })

  it('finds meter peaks by engine index', () => {
    expect(trackPeaks([{ index: 1, left: 0.5, right: 0.25 }], 1)).toEqual([0.5, 0.25])
    expect(trackPeaks([], 0)).toEqual([0, 0])
  })
})
