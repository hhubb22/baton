import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vite-plus/test'
import { ErrorBoundary } from './ErrorBoundary'
import { diagnosticText, recordFailure, resetFailures } from './diagnostics'
import { Banner } from '../ui/Banner'
import { createTransport } from '../data/http/transport'

it('copies only bounded request diagnostics from the error screen', async () => {
  const traceId = 'a'.repeat(32)
  const threadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  recordFailure(`/threads/${threadId}/messages?secret=prompt`, `00-${traceId}-${'b'.repeat(16)}-01`, 'forbidden')
  const text = diagnosticText()
  expect(JSON.parse(text)).toMatchObject({ trace_id: traceId, thread_id: threadId, error_code: 'forbidden' })
  expect(text).not.toContain('secret')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  function Broken(): never {
    throw new Error('secret /private/path')
  }
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text))
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
    expect(writeText.mock.calls[0]?.[0]).not.toContain('/private/path')
  } finally {
    consoleError.mockRestore()
  }
})

it('shows copy failure on request errors and clears diagnostics on logout', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('blocked'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const fetcher = vi.fn().mockRejectedValue(new Error('private network detail'))
  const transport = createTransport({ fetch: fetcher })
  await expect(transport.request('/projects/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).rejects.toThrow()
  expect(JSON.parse(diagnosticText())).toMatchObject({
    error_code: 'unavailable',
    project_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  })
  expect(diagnosticText()).not.toContain('private network detail')
  render(<Banner icon="alert" title="无法加载" />)
  fireEvent.click(screen.getByRole('button', { name: '复制诊断信息' }))
  expect(await screen.findByRole('button', { name: '复制失败，请重试' })).toBeInTheDocument()
  transport.clear()
  await waitFor(() => expect(screen.queryByRole('button', { name: '复制失败，请重试' })).toBeNull())
  expect(diagnosticText()).not.toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  resetFailures()
})
