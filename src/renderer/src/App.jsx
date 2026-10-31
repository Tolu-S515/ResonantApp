import { Route, Routes } from 'react-router'
import Home from './pages/Home.jsx'
import Convert from './pages/Convert.jsx'
import './App.css'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/convert" element={<Convert />} />
    </Routes>
  )
}

export default App
