import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HomePage } from './HomePage.tsx'
import './home.css'

const root = document.getElementById('root')
if (!root) throw new Error('缺少页面根节点')

createRoot(root).render(
  <StrictMode>
    <HomePage />
  </StrictMode>,
)
