import { useState } from 'react'
import { diagnosticText } from './diagnostics'
import { Button } from '../ui/Button'

export function DiagnosticCopy() {
  const [result, setResult] = useState<'ready' | 'copied' | 'failed'>('ready')
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(diagnosticText())
      setResult('copied')
    } catch {
      setResult('failed')
    }
  }
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void copy()
      }}
    >
      {result === 'copied' ? '已复制' : result === 'failed' ? '复制失败，请重试' : '复制诊断信息'}
    </Button>
  )
}
