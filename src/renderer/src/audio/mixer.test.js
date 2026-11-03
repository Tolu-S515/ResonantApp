import { describe, expect, it } from 'vitest'
import { effectiveGains } from './mixer.js'

const track = (overrides = {}) => ({ muted: false, soloed: false, gain: 1, ...overrides })

describe('effectiveGains', () => {
  it('passes gain through when nothing is muted or soloed', () => {
    expect(effectiveGains({ a: track({ gain: 0.5 }), b: track() })).toEqual({ a: 0.5, b: 1 })
  })

  it('silences muted tracks', () => {
    expect(effectiveGains({ a: track({ muted: true }), b: track() })).toEqual({ a: 0, b: 1 })
  })

  it('plays only soloed tracks when any track is soloed', () => {
    expect(effectiveGains({ a: track({ soloed: true }), b: track(), c: track({ soloed: true, gain: 0.3 }) })).toEqual({
      a: 1,
      b: 0,
      c: 0.3,
    })
  })

  it('lets mute win over solo', () => {
    expect(effectiveGains({ a: track({ soloed: true, muted: true }), b: track() })).toEqual({ a: 0, b: 0 })
  })
})
