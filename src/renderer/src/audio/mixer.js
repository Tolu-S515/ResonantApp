// The gain each track should actually play at, given its mute/solo/gain settings.
// If any track is soloed, only soloed tracks play. Mute always wins.
export function effectiveGains(mixer) {
  const anySoloed = Object.values(mixer).some((t) => t.soloed)
  return Object.fromEntries(
    Object.entries(mixer).map(([id, t]) => [
      id,
      t.muted || (anySoloed && !t.soloed) ? 0 : t.gain,
    ]),
  )
}
