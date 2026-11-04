import { useEffect, useId, useRef, useState } from 'react'
import './Dropdown.css'

// Compact styled dropdown. options: [{ value, label, disabled }].
// Opens below the button (above it near the bottom of the window). Arrow keys move,
// Enter/Space picks, Escape closes; clicking outside or scrolling closes too.
export default function Dropdown({ value, options, onChange, label, className = '' }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState(null)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const listId = useId()
  const selected = options.find((o) => o.value === value)

  function openMenu() {
    const rect = buttonRef.current.getBoundingClientRect()
    const menuHeight = options.length * 30 + 10
    const below = rect.bottom + 4 + menuHeight <= window.innerHeight
    setPosition({ left: rect.left, minWidth: rect.width, ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }) })
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  function close({ focus = true } = {}) {
    setOpen(false)
    if (focus) buttonRef.current?.focus()
  }

  function pick(option) {
    if (option.disabled) return
    close()
    if (option.value !== value) onChange(option.value)
  }

  // Next enabled option from `from`, stepping by `step`
  function move(from, step) {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + step * i + options.length) % options.length
      if (!options[next].disabled) return next
    }
    return from
  }

  function handleKeyDown(event) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openMenu()
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((a) => move(a, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (options[active]) pick(options[active])
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      close({ focus: event.key === 'Escape' })
    }
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) close({ focus: false })
    }
    const onScroll = (e) => !menuRef.current?.contains(e.target) && close({ focus: false })
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`dropdown${open ? ' dropdown--open' : ''} ${className}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className="dropdown__value">{selected?.label ?? '—'}</span>
        <svg className="dropdown__chevron" viewBox="0 0 12 8" width="8" height="6" aria-hidden="true">
          <path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && position && (
        <ul ref={menuRef} id={listId} className="dropdown__menu" role="listbox" aria-label={label} style={position}>
          {options.map((option, i) => {
            const isSelected = option.value === value
            return (
              <li
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                className={`dropdown__option${i === active ? ' dropdown__option--active' : ''}`}
                onPointerEnter={() => !option.disabled && setActive(i)}
                onClick={() => pick(option)}
              >
                <span className="dropdown__check" aria-hidden="true">
                  {isSelected ? '✓' : ''}
                </span>
                {option.label}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
