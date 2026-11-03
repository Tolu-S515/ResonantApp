import { useRef, useState } from 'react'
import { AUDIO_EXTENSIONS, isAudioFile } from '../../../shared/audio.js'
import './FileDropzone.css'

function FileDropzone({ file, onFileSelected }) {
  const inputRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState(null)

  // Shared by click-to-browse and drag-and-drop
  function selectFile(selected) {
    if (!isAudioFile(selected.name)) {
      setError(`Unsupported file type. Use ${AUDIO_EXTENSIONS.join(', ')}.`)
      return
    }
    setError(null)
    onFileSelected({ path: window.resonant.getPathForFile(selected), name: selected.name })
  }

  function handleInputChange(e) {
    const selected = e.target.files[0]
    if (selected) selectFile(selected)
    // Reset so choosing the same file again still fires onChange
    e.target.value = ''
  }

  function handleDragOver(e) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e) {
    // Ignore dragleave events fired when moving over child elements
    if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    setIsDragging(false)

    const dropped = e.dataTransfer.files[0]
    if (dropped) selectFile(dropped)
  }

  const className = ['dropzone', isDragging && 'dropzone--dragging', file && 'dropzone--filled']
    .filter(Boolean)
    .join(' ')

  return (
    <div className="dropzone-wrapper">
      <input
        ref={inputRef}
        type="file"
        accept={AUDIO_EXTENSIONS.map((ext) => `.${ext}`).join(',')}
        hidden
        onChange={handleInputChange}
      />
      <button
        type="button"
        className={className}
        onClick={() => inputRef.current.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="dropzone__circle" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        {file ? (
          <>
            <span className="dropzone__title" title={file.path}>
              {file.name}
            </span>
            <span className="dropzone__hint">Click or drop to choose a different file</span>
          </>
        ) : (
          <>
            <span className="dropzone__title">Add a song</span>
            <span className="dropzone__hint">Click to browse or drop a file here</span>
          </>
        )}
      </button>
      {error && (
        <p className="dropzone__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default FileDropzone
