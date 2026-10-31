import { Link } from 'react-router'
import logo from '../assets/resonant-logo.svg'

function Home() {
  return (
    <main className="app">
      <img src={logo} className="logo" alt="Resonant logo" />
      <h1>Resonant</h1>
      <Link to="/convert" className="button">
        Proceed
      </Link>
    </main>
  )
}

export default Home
