import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { App } from '../app/App'
import { createAppRouter } from '../app/router'
import { createMockClient } from '../data/mock/client'
import { createDesktopBridge, registeredDesktop } from '../test/desktop'

afterEach(() => vi.unstubAllGlobals())

describe('desktop app link', () => {
  it.each([
    [undefined, true, true, true],
    [1, true, true, false],
    [2, true, true, true],
    [undefined, false, false, false],
    [undefined, true, false, false],
  ])('handles bridge %s, downloads %s and connect URL %s', async (protocol, enabled, hasLink, visible) => {
    vi.stubGlobal(
      'batonDesktop',
      protocol === 1 ? createDesktopBridge().bridge : protocol === undefined ? undefined : { protocol },
    )
    const client = createMockClient(enabled ? 'downloads' : 'noDownloads', {
      latency: { read: 0, save: 0, device: 0, run: 8000 },
    })
    const downloads = await client.getDownloads()
    const getDownloads = vi.spyOn(client, 'getDownloads').mockResolvedValue({
      ...downloads,
      connect_url: hasLink ? downloads.connect_url : null,
    })
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
    render(<App client={client} router={router} />)
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    await waitFor(() => expect(getDownloads).toHaveBeenCalled())
    if (visible) {
      expect(await screen.findByRole('link', { name: 'Open in desktop app' })).toHaveAttribute(
        'href',
        downloads.connect_url,
      )
    } else {
      expect(screen.queryByRole('link', { name: 'Open in desktop app' })).not.toBeInTheDocument()
    }
  })
})

function desktopPage(initial = createDesktopBridge()) {
  vi.stubGlobal('batonDesktop', initial.bridge)
  const client = createMockClient('downloads', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  return {
    client,
    desktop: initial,
    user: userEvent.setup(),
    show: () => render(<App client={client} router={router} />),
  }
}

it('offers local setup and tracks desktop updates, including external ownership and rejection reasons', async () => {
  const f = desktopPage()
  const view = f.show()
  await screen.findByRole('button', { name: 'Connect this computer' })
  expect(screen.queryByRole('button', { name: 'Connect a device' })).not.toBeInTheDocument()
  await act(async () => f.desktop.publish(registeredDesktop))
  await waitFor(() => expect(screen.getByRole('region', { name: 'This computer' })).toHaveTextContent('Online'))
  expect(screen.queryByRole('button', { name: 'Connect this computer' })).not.toBeInTheDocument()
  await act(async () =>
    f.desktop.publish({ ...registeredDesktop, state: 'external', connection_state: 'rejected', code: 'needs_reauth' }),
  )
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'This computer' })).toHaveTextContent('Managed by external service'),
  )
  expect(screen.getByText('Sign-in expired on this computer.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Reconnect this computer' })).toBeInTheDocument()
  await act(async () =>
    f.desktop.publish({ ...registeredDesktop, state: 'rejected', code: 'node_version_incompatible' }),
  )
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'This computer' })).toHaveTextContent('Connection refused'),
  )
  expect(screen.getByText('Download the latest desktop app from Baton.')).toBeInTheDocument()
  await act(async () => f.desktop.publish({ ...registeredDesktop, state: 'rejected', message: 'Certificate expired.' }))
  expect(await screen.findByText('Certificate expired.')).toBeInTheDocument()
  view.unmount()
  expect(f.desktop.listeners.size).toBe(0)
})

it('reauthenticates the local idle-expired device using the current account API and bridge identity', async () => {
  const f = desktopPage(createDesktopBridge(registeredDesktop))
  const list = await f.client.listDevices()
  vi.spyOn(f.client, 'listDevices').mockResolvedValue(
    list.map((device) => (device.id === 'dev-mac' ? { ...device, credentialState: 'idle_expired' } : device)),
  )
  const create = vi.spyOn(f.client, 'createEnrollment')
  f.desktop.bridge.reauth.mockResolvedValue(registeredDesktop)
  f.show()
  await f.user.click(await screen.findByRole('button', { name: 'Reconnect this computer' }))
  await f.user.click(await screen.findByRole('button', { name: 'Reconnect' }))
  await waitFor(() => expect(f.desktop.bridge.reauth).toHaveBeenCalledTimes(1))
  expect(create).toHaveBeenCalledWith('dev-mac')
  const issued = await create.mock.results[0]!.value
  expect(document.body).not.toHaveTextContent(issued.code)
  expect(f.desktop.bridge.enroll).not.toHaveBeenCalled()
})

it('opens local setup with an editable, empty device name', async () => {
  const f = desktopPage()
  f.show()
  await f.user.click(await screen.findByRole('button', { name: 'Connect this computer' }))
  expect(await screen.findByRole('dialog', { name: 'Connect this computer' })).toBeInTheDocument()
  expect(screen.getByLabelText('Device name')).toHaveValue('')
  expect(screen.queryByLabelText('Run in terminal')).not.toBeInTheDocument()
})

it('retries failed status reads and ignores an older initial read after a status notification', async () => {
  const f = desktopPage()
  f.desktop.bridge.status.mockRejectedValueOnce(new Error('IPC unavailable'))
  f.show()
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read this computer's status.")
  let finish!: (status: typeof registeredDesktop) => void
  f.desktop.bridge.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await f.user.click(screen.getByRole('button', { name: 'Try again' }))
  await act(async () => f.desktop.publish(registeredDesktop))
  await act(async () => finish({ registered: false, state: 'unregistered' }))
  await waitFor(() => expect(screen.getByRole('region', { name: 'This computer' })).toHaveTextContent('Online'))
  expect(screen.queryByRole('button', { name: 'Connect this computer' })).not.toBeInTheDocument()
})
