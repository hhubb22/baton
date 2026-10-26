import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ClientError, type BatonClient } from '../data/client'
import { createMockClient } from '../data/mock/client'
import type { FilePreview as PreviewData } from '../data/types'
import { ClientProvider } from '../data/queries'
import { App } from './App'
import { FolderDialog } from './FolderDialog'
import { createAppRouter } from './router'

const deviceId = 'dev-ubuntu'
const path = '/home/kaken/work/baton/logs/reconnect.log'
const first: Extract<PreviewData, { state: 'ready' }> = {
  state: 'ready',
  deviceId,
  path,
  size: 20,
  content: 'first\npar',
  truncated: true,
  offset: 0,
  version: 'v1',
  nextOffset: 9,
}

function setup(readFile: BatonClient['readFile']) {
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  client.readFile = readFile
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/threads?thread=thr-gateway'] }) })
  render(<App client={client} router={router} />)
  return client
}

async function openPreview(user: ReturnType<typeof userEvent.setup>) {
  const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
  await user.click(await within(detail).findByRole('button', { name: 'View reconnect.log' }))
  return screen.findByRole('dialog', { name: 'logs/reconnect.log' })
}

beforeEach(() => localStorage.clear())

describe('folder selection', () => {
  it('keeps selectable folders while retrying an incomplete directory list', async () => {
    const user = userEvent.setup()
    const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
    const root = '/extra:root\\literal'
    let reloading = false
    let complete = () => {}
    const refresh = new Promise<void>((resolve) => {
      complete = resolve
    })
    client.listFolders = async (_device, path) => {
      if (path !== null && reloading) await refresh
      return {
        state: 'ready',
        deviceId,
        path,
        folders: path === null ? [root] : [root + '/name:part\\literal', ...(reloading ? [root + '/after-retry'] : [])],
        files: [],
        scanLimited: path !== null && !reloading,
      }
    }
    const selected = vi.fn()
    render(
      <ClientProvider client={client}>
        <FolderDialog deviceId={deviceId} onClose={() => {}} onSelect={selected} />
      </ClientProvider>,
    )
    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    await user.click(await within(dialog).findByRole('button', { name: root }))
    const folder = await within(dialog).findByRole('button', { name: 'name:part\\literal' })
    expect(within(dialog).getByRole('button', { name: 'Back to folders' })).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('Folder scan limited')
    reloading = true
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    expect(folder).toBeInTheDocument()
    await act(async () => complete())
    expect(await within(dialog).findByRole('button', { name: 'after-retry' })).toBeInTheDocument()
    expect(within(dialog).queryByText(/Folder scan limited/)).not.toBeInTheDocument()
    await user.click(folder)
    await user.click(within(dialog).getByRole('button', { name: 'Select folder' }))
    expect(selected).toHaveBeenCalledWith({ deviceId, folder: root + '/name:part\\literal' })
  })
})

describe('file preview paging', () => {
  it('appends fragments across line boundaries and retries without losing earlier text', async () => {
    const user = userEvent.setup()
    let failed = false
    const read = vi.fn<BatonClient['readFile']>(async (_device, _path, options) => {
      if (!options) return first
      if (!failed) {
        failed = true
        throw new ClientError('unavailable', 'Read failed')
      }
      return { ...first, content: 'tial\n最后', offset: 9, nextOffset: undefined, truncated: false }
    })
    setup(read)
    const dialog = await openPreview(user)
    await user.click(await within(dialog).findByRole('button', { name: 'Continue reading' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't read more")
    expect(within(dialog).getByRole('region')).toHaveTextContent('first')
    await user.click(within(dialog).getByRole('button', { name: 'Continue reading' }))
    expect(await within(dialog).findByText('partial')).toBeInTheDocument()
    expect(within(dialog).getByText('first')).toBeInTheDocument()
    expect(within(dialog).getByText('最后')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Continue reading' })).not.toBeInTheDocument()
    expect(read).toHaveBeenLastCalledWith(deviceId, path, { offset: 9, version: 'v1' })
  })

  it('reloads after a version change without mixing old and new text', async () => {
    const user = userEvent.setup()
    let changed = false
    setup(async (_device, _path, options) => {
      if (options) {
        changed = true
        throw new ClientError('conflict', 'File changed')
      }
      return changed
        ? { ...first, content: 'new version', version: 'v2', nextOffset: undefined, truncated: false }
        : first
    })
    const dialog = await openPreview(user)
    await user.click(await within(dialog).findByRole('button', { name: 'Continue reading' }))
    expect(await within(dialog).findByText('File changed')).toBeInTheDocument()
    expect(within(dialog).queryByRole('region')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Reload file' }))
    expect(await within(dialog).findByText('new version')).toBeInTheDocument()
    expect(within(dialog).queryByText('first')).not.toBeInTheDocument()
  })

  it('drops appended text after a device goes offline', async () => {
    const user = userEvent.setup()
    const read = vi.fn<BatonClient['readFile']>(async (_device, _path, options) =>
      options ? { ...first, offset: 9, content: 'tial', nextOffset: undefined, truncated: false } : first,
    )
    const client = setup(read)
    const dialog = await openPreview(user)
    await user.click(await within(dialog).findByRole('button', { name: 'Continue reading' }))
    expect(await within(dialog).findByText('partial')).toBeInTheDocument()
    read.mockResolvedValue({ state: 'unavailable', deviceId, path, reason: 'offline', size: null })
    act(() => client.controls.setDeviceConnection(deviceId, 'offline'))
    expect(await within(dialog).findByText('Ubuntu Dev is offline')).toBeInTheDocument()
    expect(within(dialog).queryByText('partial')).not.toBeInTheDocument()
  })

  it('keeps retained entries while retrying an incomplete file list with literal POSIX names', async () => {
    const user = userEvent.setup()
    const client = setup(async () => ({ ...first, path: '/extra/logs/reconnect.log' }))
    const messages = client.listMessages.bind(client)
    client.listMessages = async (id) =>
      (await messages(id)).map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) =>
          attachment.kind === 'file' && attachment.path === path
            ? { ...attachment, path: '/extra/logs/reconnect.log' }
            : attachment,
        ),
      }))
    let reloading = false
    let complete = () => {}
    const refresh = new Promise<void>((resolve) => {
      complete = resolve
    })
    client.listFolders = async (_device, folder) => {
      if (folder !== null && reloading) await refresh
      return {
        state: 'ready',
        deviceId,
        path: folder,
        folders: folder === null ? ['/extra'] : [],
        files:
          folder === null
            ? []
            : [
                { path: '/extra/logs/name:part\\literal', size: 10 },
                ...(reloading ? [{ path: '/extra/logs/after-retry.txt', size: 20 }] : []),
              ],
        scanLimited: folder !== null && !reloading,
      }
    }
    const dialog = await openPreview(user)
    const nav = within(dialog).getByRole('navigation', { name: 'Folders' })
    expect(await within(nav).findByRole('button', { name: /name:part\\literal/ })).toBeInTheDocument()
    expect(within(nav).getByRole('status')).toHaveTextContent('Folder scan limited')
    expect(within(nav).queryByText('This folder is empty')).not.toBeInTheDocument()
    reloading = true
    await user.click(within(nav).getByRole('button', { name: 'Retry' }))
    expect(within(nav).getByRole('button', { name: /name:part\\literal/ })).toBeInTheDocument()
    await act(async () => complete())
    expect(await within(nav).findByRole('button', { name: /after-retry.txt/ })).toBeInTheDocument()
    expect(within(nav).queryByText(/Folder scan limited/)).not.toBeInTheDocument()
  })
})
