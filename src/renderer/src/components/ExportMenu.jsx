import { useEffect, useRef, useState } from 'react'
import './SettingsMenu.css'
import './ExportMenu.css'

// Export button that opens a small panel: which part of the song, whether to include
// the click, and Save. ranges: from exportRanges(). onExport(range, withClick)
// resolves with the saved path (null if the save dialog was cancelled).
// disabled: why export isn't possible right now, if it isn't.
export default function ExportMenu({ ranges, onExport, disabled }) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState(null)
  const [withClick, setWithClick] = useState(false)
  const [state, setState] = useState({ busy: false, saved: null, error: null })
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e) => !rootRef.current?.contains(e.target) && setOpen(false)
    const onKeyDown = (e) => e.key === 'Escape' && !state.busy && setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, state.busy])

  // The first range on offer (where you played, if there are takes) unless one was picked
  const range = ranges.find((r) => r.value === choice) ?? ranges[0]

  async function save() {
    setState({ busy: true, saved: null, error: null })
    try {
      const saved = await onExport(range, withClick)
      setState({ busy: false, saved, error: null })
    } catch (err) {
      setState({ busy: false, saved: null, error: err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    }
  }

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className={`button button--secondary icon-button${open ? ' icon-button--active' : ''}`}
        aria-label="Export"
        title={disabled ?? 'Export to a WAV file'}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={Boolean(disabled)}
        onClick={() => {
          setOpen((o) => !o)
          setState((s) => (s.busy ? s : { busy: false, saved: null, error: null }))
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
      </button>
      {open && range && (
        <div className="settings-menu__panel export-menu" role="dialog" aria-label="Export">
          <h2 className="export-menu__title">Export</h2>
          <p className="export-menu__hint">Everything you can hear, as one WAV file.</p>
          <div className="export-menu__ranges" role="radiogroup" aria-label="Part of the song">
            {ranges.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={r === range}
                className={`export-menu__range${r === range ? ' export-menu__range--selected' : ''}`}
                onClick={() => setChoice(r.value)}
                disabled={state.busy}
              >
                <span className="export-menu__radio" aria-hidden="true" />
                <span className="export-menu__range-label">{r.label}</span>
                <span className="export-menu__range-time">{r.detail}</span>
              </button>
            ))}
          </div>
          <label className="export-menu__check">
            <input type="checkbox" checked={withClick} onChange={(e) => setWithClick(e.target.checked)} disabled={state.busy} />
            Include the metronome
          </label>
          <div className="export-menu__footer">
            {state.saved && (
              <button type="button" className="export-menu__link" onClick={() => window.resonant.revealExport(state.saved)}>
                Saved. Show in Finder
              </button>
            )}
            {state.error && (
              <span className="error" role="alert">
                {state.error}
              </span>
            )}
            <button type="button" className="button export-menu__save" onClick={save} disabled={state.busy}>
              {state.busy ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
