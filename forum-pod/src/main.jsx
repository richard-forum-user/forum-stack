import React from 'react'
import ReactDOM from 'react-dom/client'
import PersonalPod from './pod-ui.jsx' // Import your pod component
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PersonalPod />
  </React.StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`)
      .catch((err) => console.warn('Service worker registration failed:', err))
  })
}