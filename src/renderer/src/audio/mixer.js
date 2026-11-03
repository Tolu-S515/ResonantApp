// The gain each track should actually play at, given its mute/solo/gain settings.
// If any track is soloed, only soloed tracks play, and every other track is silent.
// Solo wins over mute: soloing the (muted-by-default) reference plays it on its own.
export function effectiveGains(mixer) {
  const anySoloed = Object.values(mixer).some((t) => t.soloed)
  return Object.fromEntries(
    Object.entries(mixer).map(([id, t]) => {
      const audible = anySoloed ? t.soloed : !t.muted
      return [id, audible ? t.gain : 0]
    }),
  )
}

// M and S are never both lit on one track. A soloed track keeps its mute setting
// underneath (so un-soloing the reference puts it back to muted), but the M button
// shows as off while it's soloed, matching what you hear.
export function showsMuted(track) {
  return track.muted && !track.soloed
}

// Changes to apply when M is pressed. On a soloed track, M un-solos and mutes it.
export function muteToggled(track) {
  if (track.soloed) return { soloed: false, muted: true }
  return { muted: !track.muted }
}

// Changes to apply when S is pressed. The mute setting is left alone, to come back on un-solo.
export function soloToggled(track) {
  return { soloed: !track.soloed }
}
