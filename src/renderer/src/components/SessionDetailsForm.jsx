import { MAX_DETAIL_LENGTH, TIME_SIGNATURES } from '../../../shared/session.js'

// Song name, artist and time signature, filled in while the song processes.
// Controlled: the parent owns the values and decides when to save them.
function SessionDetailsForm({ values, onChange, namePlaceholder }) {
  const update = (field) => (event) => onChange({ ...values, [field]: event.target.value })

  return (
    <form className="details" onSubmit={(e) => e.preventDefault()}>
      <h2 className="details__heading">Song details</h2>
      <label className="details__field">
        <span>Song name</span>
        <input
          type="text"
          value={values.songName}
          onChange={update('songName')}
          placeholder={namePlaceholder}
          maxLength={MAX_DETAIL_LENGTH}
          autoFocus
        />
      </label>
      <label className="details__field">
        <span>Artist</span>
        <input type="text" value={values.artist} onChange={update('artist')} maxLength={MAX_DETAIL_LENGTH} />
      </label>
      <fieldset className="details__field details__meter">
        <legend>Time signature</legend>
        <div className="segmented">
          {TIME_SIGNATURES.map((signature) => (
            <label key={signature} className="segmented__option">
              <input
                type="radio"
                name="timeSignature"
                value={signature}
                checked={values.timeSignature === signature}
                onChange={update('timeSignature')}
              />
              <span>{signature}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </form>
  )
}

export default SessionDetailsForm
