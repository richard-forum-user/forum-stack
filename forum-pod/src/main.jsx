import React from 'react'
import ReactDOM from 'react-dom/client'
import PersonalPod from './pod-ui.jsx'
import TrialPodBanner from './trial-pod-banner.jsx'
import './index.css'
import { installSessionLock } from './session-lock.js'
import { migrateLegacySigningKey } from './pod-signing.js'

installSessionLock()
migrateLegacySigningKey().catch(() => {})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <TrialPodBanner />
    <PersonalPod />
  </React.StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`)
      .catch((err) => console.warn('Service worker registration failed:', err))
  })
}