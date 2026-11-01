import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import type { TraceStep } from '../data/types'
import { TraceDisclosure } from './ReplyParts'

const step = (index: number): TraceStep => ({
  item_id: `step-${index}`,
  type: 'dynamic_tool',
  status: 'running',
  ordinal: index,
  title: `步骤 ${index}`,
  data: {},
  truncated: false,
  original_bytes: 0,
})

const trace = (count: number, overrides: { live?: boolean; open?: boolean; loading?: boolean } = {}) => (
  <TraceDisclosure
    steps={Array.from({ length: count }, (_, index) => step(index + 1))}
    live={overrides.live ?? true}
    loading={overrides.loading}
    open={overrides.open ?? true}
    onOpenChange={() => undefined}
    threadId="thread-1"
    device={undefined}
  />
)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('reveals a live batch one step at a time and keeps the header count on what is shown', () => {
  const { rerender } = render(trace(1))
  expect(screen.getByRole('button', { name: /执行过程 · 1 个步骤/ })).toBeInTheDocument()
  rerender(trace(3))
  expect(screen.queryByText('步骤 2')).not.toBeInTheDocument()
  act(() => {
    vi.advanceTimersByTime(700)
  })
  expect(screen.getByText('步骤 2')).toBeInTheDocument()
  expect(screen.queryByText('步骤 3')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /执行过程 · 2 个步骤/ })).toBeInTheDocument()
})

it('shows every step at once when the first batch finishes loading or the turn has ended', () => {
  const { rerender } = render(trace(0, { loading: true }))
  rerender(trace(3))
  expect(screen.getByText('步骤 3')).toBeInTheDocument()
  rerender(trace(6, { live: false }))
  expect(screen.getByText('步骤 6')).toBeInTheDocument()
})

it('names the current step in the collapsed header and reports silence after 30 seconds', () => {
  render(trace(2, { open: false }))
  expect(screen.getByRole('button', { name: /执行过程 · 2 个步骤.*步骤 2/ })).toBeInTheDocument()
  act(() => {
    vi.advanceTimersByTime(30_000)
  })
  expect(screen.getByRole('button', { name: /30 秒没有新进展/ })).toBeInTheDocument()
})
