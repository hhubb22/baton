import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { App } from '../app/App'
import { createAppRouter } from '../app/router'
import { createMockClient } from '../data/mock/client'

afterEach(() => vi.unstubAllGlobals())

describe('desktop app link', () => {
  it.each([
    [undefined, true, true, true],
    [1, true, true, false],
    [2, true, true, true],
    [undefined, false, false, false],
    [undefined, true, false, false],
  ])('handles bridge %s, downloads %s and connect URL %s', async (protocol, enabled, hasLink, visible) => {
    vi.stubGlobal('batonDesktop', protocol === undefined ? undefined : { protocol })
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
