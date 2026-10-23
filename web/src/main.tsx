import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import type { BatonClient } from './data/client'
import { createHttpClient } from './data/http/client'
import './theme/global.css'

async function start() {
  let client: BatonClient
  let development: ReactNode = null
  const search = new URLSearchParams(window.location.search)
  if (import.meta.env.DEV && (search.get('mock') === '1' || search.has('scenario'))) {
    const [{ createBrowserClient }, { ScenarioPanel }] = await Promise.all([
      import('./dev/mock'),
      import('./dev/ScenarioPanel'),
    ])
    const mock = createBrowserClient()
    client = mock
    development = <ScenarioPanel controls={mock.controls} />
  } else {
    client = createHttpClient()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App client={client}>{development}</App>
    </StrictMode>,
  )
}

void start()
