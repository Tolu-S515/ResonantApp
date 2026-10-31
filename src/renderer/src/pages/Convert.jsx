import { useState } from 'react'
import { Link } from 'react-router'
import FileDropzone from '../components/FileDropzone.jsx'

function Convert() {
  const [file, setFile] = useState(null)

  return (
    <main className="app">
      <h1>Convert</h1>
      <p>Choose a song to split it into stems.</p>
      <div className="page-center">
        <FileDropzone file={file} onFileSelected={setFile} />
      </div>
      <Link to="/" className="back-link">
        ← Back
      </Link>
    </main>
  )
}

export default Convert
