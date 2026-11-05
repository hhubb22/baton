import { Component, type ReactNode } from 'react'
import { DiagnosticCopy } from './DiagnosticCopy'
import { Button } from '../ui/Button'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main>
        <h1>页面无法显示</h1>
        <Button onClick={() => window.location.reload()}>重新加载</Button>
        <DiagnosticCopy />
      </main>
    )
  }
}
