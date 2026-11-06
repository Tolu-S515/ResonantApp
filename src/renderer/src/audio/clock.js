// The page's clock (performance.now) and the wall clock (Date.now) side by side,
// for lining recordings up with the native engine, which reports wall-clock times.

// Date.now() - performance.now(), to well under a millisecond. Date.now() only
// counts whole ms, so this waits (at most a couple of ms) for it to tick over and
// reads performance.now() at that moment.
export function epochOffset(dateNow = Date.now, perfNow = () => performance.now()) {
  const first = dateNow()
  const limit = perfNow() + 2
  let now
  let perf
  do {
    now = dateNow()
    perf = perfNow()
  } while (now === first && perf < limit)
  return now - perf
}
