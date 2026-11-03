import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// protocol.js imports electron, which isn't available under plain Node
vi.mock('electron', () => ({ net: {}, protocol: {} }))
const { resolveSessionUrl } = await import('./protocol.js')

const dir = '/sessions'
const id = '3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b'

describe('resolveSessionUrl', () => {
  it('maps a file in a session folder', () => {
    expect(resolveSessionUrl(dir, `resonant://session/${id}/reference.wav`)).toBe(
      join(dir, id, 'reference.wav'),
    )
  })

  it('maps nested files', () => {
    expect(resolveSessionUrl(dir, `resonant://session/${id}/stems/drums.wav`)).toBe(
      join(dir, id, 'stems', 'drums.wav'),
    )
  })

  it.each([
    ['another scheme', `file:///sessions/${id}/reference.wav`],
    ['another host', `resonant://other/${id}/reference.wav`],
    ['a non-UUID id', 'resonant://session/not-an-id/reference.wav'],
    ['no file', `resonant://session/${id}`],
    ['the session folder itself', `resonant://session/${id}/`],
    ['dot segments', `resonant://session/${id}/../../etc/passwd`],
    ['encoded dot segments', `resonant://session/${id}/%2e%2e/%2e%2e/etc/passwd`],
    ['an encoded slash', `resonant://session/${id}/..%2F..%2Fetc%2Fpasswd`],
    ['bad percent-encoding', `resonant://session/${id}/%E0%A4%A`],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(resolveSessionUrl(dir, url)).toBeNull()
  })
})
