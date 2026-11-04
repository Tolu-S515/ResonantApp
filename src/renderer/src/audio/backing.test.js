import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKING_MIN_DB, backingGain, loadBackingDb, saveBackingDb } from './backing.js'

function fakeStorage() {
  const items = new Map()
  return {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('backing level', () => {
  it('converts dB to gain, off at the bottom', () => {
    expect(backingGain(0)).toBe(1)
    expect(backingGain(-6)).toBeCloseTo(0.501, 3)
    expect(backingGain(BACKING_MIN_DB)).toBe(0)
  })

  it('remembers the level, defaulting to 0 dB', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(loadBackingDb()).toBe(0)
    saveBackingDb(-12)
    expect(loadBackingDb()).toBe(-12)
  })

  it('ignores bad saved values and missing storage', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    localStorage.setItem('resonant.backingDb', 'loud')
    expect(loadBackingDb()).toBe(0)
    localStorage.setItem('resonant.backingDb', '99')
    expect(loadBackingDb()).toBe(6)
    vi.stubGlobal('localStorage', undefined)
    expect(loadBackingDb()).toBe(0)
    expect(() => saveBackingDb(-3)).not.toThrow()
  })
})
