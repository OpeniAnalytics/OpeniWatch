import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { configuration } from './lib/env'
import { registerServiceWorker } from './services/pwa/register'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root was not found in index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * Service worker registration.
 *
 * Skipped entirely when configuration is blocked: a misconfigured deployment
 * must not install a worker that would then serve its shell from cache and make
 * the fault look intermittent to whoever is trying to fix it.
 *
 * The update callback is dispatched as a DOM event rather than threaded through
 * React state, so registration stays independent of the render tree.
 */
if (configuration.status !== 'blocked') {
  void registerServiceWorker((activate) => {
    window.dispatchEvent(new CustomEvent('openiwatch:update-ready', { detail: { activate } }))
  })
}
