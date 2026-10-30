import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import './lib/i18n'
import App from './App'
import { AuthProvider } from './lib/auth'
import { ManagerPinProvider, ToastProvider } from './components/ui'

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 } } })

// Never auto-reload during an open order: ask first (§9.4).
const updateSW = registerSW({
  onNeedRefresh() {
    const bar = document.createElement('button')
    bar.textContent = 'New version available — tap to refresh'
    bar.className = 'fixed top-2 left-1/2 -translate-x-1/2 z-[100] rounded-xl bg-gold-400 text-charcoal-950 font-semibold px-4 py-3 shadow-lg'
    bar.onclick = () => updateSW(true)
    document.body.appendChild(bar)
  },
})

// Ask the browser not to evict the offline outbox (§9.4).
navigator.storage?.persist?.().then((ok) => { if (!ok) console.warn('Persistent storage was refused; offline data may be cleared by the browser.') })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <ManagerPinProvider>
              <App />
            </ManagerPinProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
