import { useState } from 'react'

// Stops processing for a session. The button disappears once the session's
// status changes to 'cancelled' (the parent stops rendering it).
function CancelButton({ sessionId }) {
  const [isCancelling, setIsCancelling] = useState(false)

  async function handleClick() {
    setIsCancelling(true)
    try {
      await window.resonant.cancelProcessing(sessionId)
    } catch {
      setIsCancelling(false)
    }
  }

  return (
    <button type="button" className="button button--secondary" onClick={handleClick} disabled={isCancelling}>
      {isCancelling ? 'Cancelling…' : 'Cancel'}
    </button>
  )
}

export default CancelButton
