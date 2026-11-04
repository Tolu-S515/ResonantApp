import { Route, Routes } from 'react-router'
import { useDeviceChange } from './audio/useAudioState.js'
import Home from './pages/Home.jsx'
import Convert from './pages/Convert.jsx'
import Player from './pages/Player.jsx'
import './App.css'

// Plugging the interface in (or out) starts (or stops) the audio engine
const reconnectAudio = () => window.resonant.audio.connect()

function App() {
  useDeviceChange(reconnectAudio)
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/convert" element={<Convert />} />
      <Route path="/player" element={<Player />} />
      <Route path="/player/:sessionId" element={<Player />} />
    </Routes>
  )
}

export default App
