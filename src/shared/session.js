// Session fields the user edits (song details form, player bar start). Shared so the UI and the
// main-process validation agree on the rules.

export const TIME_SIGNATURES = ['4/4', '3/4', '6/8']
export const MAX_DETAIL_LENGTH = 200
// Bar start shift, in beats. Up to one beat short of the longest bar (4/4).
export const MAX_BAR_SHIFT = 3

// Returns only the recognised, valid fields from untrusted input:
// trimmed strings (empty → null), a known time signature and a bar shift. Throws on anything else.
export function sanitizeDetails(input) {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid details')
  const details = {}
  for (const key of ['songName', 'artist']) {
    if (!(key in input)) continue
    const value = input[key]
    if (value !== null && typeof value !== 'string') throw new Error(`Invalid ${key}`)
    const trimmed = (value ?? '').trim().slice(0, MAX_DETAIL_LENGTH)
    details[key] = trimmed || null
  }
  if ('timeSignature' in input) {
    if (!TIME_SIGNATURES.includes(input.timeSignature)) throw new Error('Invalid time signature')
    details.timeSignature = input.timeSignature
  }
  if ('barShift' in input) {
    const { barShift } = input
    if (!Number.isInteger(barShift) || barShift < 0 || barShift > MAX_BAR_SHIFT) throw new Error('Invalid bar shift')
    details.barShift = barShift
  }
  return details
}
