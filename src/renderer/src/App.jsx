import { Route, Routes } from 'react-router'
import Home from './pages/Home.jsx'
import Convert from './pages/Convert.jsx'
import Player from './pages/Player.jsx'
import './App.css'

function App() {
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
