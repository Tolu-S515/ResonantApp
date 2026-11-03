import { describe, expect, it } from 'vitest'
import { effectiveGains, muteToggled, showsMuted, soloToggled } from './mixer.js'

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

  it('plays a soloed track even if it is muted, silencing the rest', () => {
    // The reference starts muted; soloing it should play it alone
    const mixer = { reference: track({ muted: true, soloed: true }), drums: track(), bass: track({ gain: 0.5 }) }
    expect(effectiveGains(mixer)).toEqual({ reference: 1, drums: 0, bass: 0 })
  })

  it('goes back to mute settings once nothing is soloed', () => {
    expect(effectiveGains({ reference: track({ muted: true }), drums: track() })).toEqual({ reference: 0, drums: 1 })
  })
})

describe('mute and solo buttons', () => {
  it('shows M off while a muted track is soloed', () => {
    expect(showsMuted(track({ muted: true }))).toBe(true)
    expect(showsMuted(track({ muted: true, soloed: true }))).toBe(false)
  })

  it('soloing a muted track and un-soloing it brings the mute back', () => {
    let reference = track({ muted: true })
    reference = { ...reference, ...soloToggled(reference) }
    expect(reference).toMatchObject({ muted: true, soloed: true })
    reference = { ...reference, ...soloToggled(reference) }
    expect(reference).toMatchObject({ muted: true, soloed: false })
    expect(showsMuted(reference)).toBe(true)
  })

  it('pressing M on a soloed track un-solos and mutes it', () => {
    expect(muteToggled(track({ soloed: true }))).toEqual({ soloed: false, muted: true })
    expect(muteToggled(track({ soloed: true, muted: true }))).toEqual({ soloed: false, muted: true })
  })

  it('pressing M on an unsoloed track toggles mute', () => {
    expect(muteToggled(track())).toEqual({ muted: true })
    expect(muteToggled(track({ muted: true }))).toEqual({ muted: false })
  })
})
