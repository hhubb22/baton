import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { createBrowserClient } from './dev/mock'
import { ScenarioPanel } from './dev/ScenarioPanel'
import './theme/global.css'

// 后端客户端接入前，页面使用模拟数据；开发模式下右下角可以切换场景。
const client = createBrowserClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client}>{import.meta.env.DEV && <ScenarioPanel controls={client.controls} />}</App>
  </StrictMode>,
)
