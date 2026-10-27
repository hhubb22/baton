import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createDesktopBridge, registeredDesktop } from '../test/desktop'
import { useDesktopStatus, type DesktopStatus } from './desktop'
import { createQueryClient } from './queries'

function StatusConsumers({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => <StatusConsumer key={index} />)
}

function StatusConsumer() {
  const desktop = useDesktopStatus()
  return <output>{desktop.data?.state ?? 'Loading'}</output>
}

afterEach(() => vi.unstubAllGlobals())

it('shares one desktop subscription across consumers, preserves newer events, and releases the last subscriber', async () => {
  const desktop = createDesktopBridge()
  vi.stubGlobal('batonDesktop', desktop.bridge)
  let finish!: (status: DesktopStatus) => void
  desktop.bridge.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const cache = createQueryClient()
  const cancel = vi.spyOn(cache, 'cancelQueries')
  const consumers = (count: number) => (
    <QueryClientProvider client={cache}>
      <StatusConsumers count={count} />
    </QueryClientProvider>
  )
  const view = render(consumers(16))
  await waitFor(() => expect(desktop.bridge.status).toHaveBeenCalledTimes(1))
  expect(desktop.listeners.size).toBe(1)
  expect(desktop.bridge.onStatus).toHaveBeenCalledTimes(1)

  await act(async () => desktop.publish(registeredDesktop))
  await waitFor(() => expect(screen.getAllByText('online')).toHaveLength(16))
  expect(cancel).toHaveBeenCalledTimes(1)
  await act(async () => finish({ registered: false, state: 'unregistered' }))
  expect(screen.getAllByText('online')).toHaveLength(16)

  view.rerender(consumers(4))
  expect(desktop.listeners.size).toBe(1)
  await act(async () => desktop.publish({ ...registeredDesktop, state: 'external' }))
  await waitFor(() => expect(screen.getAllByText('external')).toHaveLength(4))
  expect(cancel).toHaveBeenCalledTimes(2)
  view.rerender(consumers(0))
  expect(desktop.listeners.size).toBe(0)

  view.rerender(consumers(2))
  expect(desktop.listeners.size).toBe(1)
  await act(async () => desktop.publish(registeredDesktop))
  await waitFor(() => expect(screen.getAllByText('online')).toHaveLength(2))
  view.unmount()
  expect(desktop.listeners.size).toBe(0)
  cache.clear()
})
