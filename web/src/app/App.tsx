import { CSPProvider } from '@base-ui/react/csp-provider'
import { RouterProvider } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import type { BatonClient } from '../data/client'
import { ClientProvider } from '../data/queries'
import { ThemeProvider } from '../theme/ThemeProvider'
import { createAppRouter } from './router'

// 页面只依赖 BatonClient，测试和开发时传入模拟实现。
// Base UI 复用静态样式表，不在运行时插入 <style>。
export function App({
  client,
  router: given,
  children,
}: {
  client: BatonClient
  router?: ReturnType<typeof createAppRouter>
  children?: ReactNode
}) {
  const [router] = useState(() => given ?? createAppRouter())
  return (
    <CSPProvider disableStyleElements>
      <ThemeProvider>
        <ClientProvider client={client}>
          <RouterProvider router={router} />
          {children}
        </ClientProvider>
      </ThemeProvider>
    </CSPProvider>
  )
}
