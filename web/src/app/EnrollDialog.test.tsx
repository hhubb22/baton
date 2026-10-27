import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { ClientProvider } from '../data/queries'
import type { DeviceOS } from '../data/types'
import { EnrollDialog } from './EnrollDialog'

function setup(scenario: ScenarioId = 'downloads', device?: { os: DeviceOS }) {
  const client = createMockClient(scenario, { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const create = vi.spyOn(client, 'createEnrollment')
  const renderDialog = async () => {
    const original = device ? (await client.listDevices()).find((item) => item.os === device.os)! : undefined
    render(
      <ClientProvider client={client}>
        <EnrollDialog device={original} onClose={() => {}} />
      </ClientProvider>,
    )
    await screen.findByText('Waiting for device…')
    return original
  }
  return { client, create, renderDialog }
}

describe('device setup downloads', () => {
  it.each([
    ['macOS', 'darwin-arm64', 'a'],
    ['Linux', 'linux-x64', 'b'],
  ] as const)(
    'offers %s downloads and setup commands without credentials or deployment flags',
    async (os, target, hash) => {
      const user = userEvent.setup()
      const f = setup()
      await f.renderDialog()
      await user.click(screen.getByRole('radio', { name: os }))
      await user.type(screen.getByLabelText('Device name'), 'Build server')
      const file = `baton-v0.1.0-${target}.tar.gz`
      const link = screen.getByRole('link', { name: `Download CLI · ${target.endsWith('x64') ? 'x64' : 'arm64'}` })
      expect(link).toHaveAttribute('href', `${window.location.origin}/downloads/${file}`)
      expect(link).toHaveAttribute('download', file)
      expect(screen.getByText(`SHA-256: ${hash.repeat(64)}`)).toBeInTheDocument()
      expect(screen.getAllByText(/v0.1.0 · \d+(\.\d+)? MB/).length).toBeGreaterThan(0)
      const curl = screen.getByLabelText('Download in terminal')
      expect(curl.textContent).toBe(`curl -fLk -O '${window.location.origin}/downloads/${file}'`)
      const command = screen.getByLabelText('Run in terminal')
      expect(command).toHaveTextContent(`tar xzf "${file}" && cd "baton-v0.1.0-${target}"`)
      expect(command).toHaveTextContent('read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN')
      expect(command).toHaveTextContent('./batond register --display-name "Build server" && ./batond service install')
      expect(command.textContent).not.toContain(screen.getByLabelText('Setup code').textContent!)
      expect(command.textContent).not.toMatch(/--coordinator|--ca-file|batond up/)
      if (os === 'macOS')
        expect(screen.getByRole('link', { name: 'Download desktop app · arm64' })).toHaveAttribute(
          'href',
          expect.stringContaining('.dmg'),
        )
    },
  )

  it('switches Linux architecture for both terminal commands', async () => {
    const user = userEvent.setup()
    await setup().renderDialog()
    await user.click(screen.getByRole('radio', { name: 'Linux' }))
    await user.click(screen.getByRole('radio', { name: 'arm64' }))
    expect(screen.getByLabelText('Download in terminal')).toHaveTextContent('baton-v0.1.0-linux-arm64.tar.gz')
    expect(screen.getByLabelText('Run in terminal')).toHaveTextContent('cd "baton-v0.1.0-linux-arm64"')
    expect(screen.getByLabelText('Run in terminal')).not.toHaveTextContent('linux-x64')
  })

  it.each([false, true])('offers the Windows desktop app without CLI commands (reauth: %s)', async (reauth) => {
    const user = userEvent.setup()
    const f = setup('downloads', reauth ? { os: 'Windows' } : undefined)
    const original = await f.renderDialog()
    if (!reauth) await user.click(screen.getByRole('radio', { name: 'Windows' }))
    expect(screen.getByRole('link', { name: 'Download desktop app · x64' })).toHaveAttribute(
      'href',
      `${window.location.origin}/downloads/baton-desktop-v0.1.0-win32-x64.exe`,
    )
    expect(screen.getByText(`SHA-256: ${'e'.repeat(64)}`)).toBeInTheDocument()
    expect(screen.getByText(/Install the desktop app/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Run in terminal')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Download in terminal')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Setup code')).not.toBeInTheDocument()
    expect(f.create).toHaveBeenCalledWith(original?.id)
  })

  it.each(['macOS', 'Linux'] as const)(
    'reauthenticates the original %s device and installs its service',
    async (os) => {
      const f = setup('downloads', { os })
      const original = await f.renderDialog()
      const command = screen.getByLabelText('Run in terminal')
      expect(command).toHaveTextContent('./batond reauth && ./batond service install')
      expect(command.textContent).not.toMatch(/--display-name|--coordinator|--ca-file|batond up/)
      expect(command.textContent).not.toContain(screen.getByLabelText('Setup code').textContent!)
      expect(f.create).toHaveBeenCalledWith(original?.id)
    },
  )

  it.each(['macOS', 'Linux', 'Windows'] as const)(
    'keeps the existing %s command when downloads are disabled',
    async (os) => {
      const user = userEvent.setup()
      await setup('noDownloads').renderDialog()
      await user.click(screen.getByRole('radio', { name: os }))
      expect(screen.getByLabelText('Run in terminal')).toHaveTextContent(
        'batond up --coordinator https://baton.example.com',
      )
      expect(screen.getByLabelText('Run in terminal')).toHaveTextContent(
        os === 'Windows' ? 'Read-Host -MaskInput' : 'read -rs BATON_ENROLLMENT_TOKEN',
      )
      expect(screen.queryByLabelText('Download in terminal')).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
    },
  )

  it('does not fall back to an unconfigured command when the selected platform has no package', async () => {
    const user = userEvent.setup()
    const f = setup()
    const downloads = await f.client.getDownloads()
    vi.spyOn(f.client, 'getDownloads').mockResolvedValue({ ...downloads, items: [] })
    await f.renderDialog()
    await user.click(screen.getByRole('radio', { name: 'Linux' }))
    expect(screen.getByText('No CLI download available for Linux.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Run in terminal')).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Windows' }))
    expect(screen.getByText('No desktop download available for Windows.')).toBeInTheDocument()
    expect(screen.queryByText(/Install the desktop app/)).not.toBeInTheDocument()
  })

  it('allows retrying a failed download query without issuing another setup code', async () => {
    const user = userEvent.setup()
    const f = setup()
    vi.spyOn(f.client, 'getDownloads').mockRejectedValueOnce(new Error('unavailable'))
    await f.renderDialog()
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load downloads.")
    expect(screen.queryByLabelText('Run in terminal')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await user.click(screen.getByRole('radio', { name: 'Linux' }))
    await waitFor(() => expect(screen.getByLabelText('Run in terminal')).toHaveTextContent('./batond register'))
    expect(f.create).toHaveBeenCalledTimes(1)
  })
})
