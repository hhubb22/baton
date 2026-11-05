import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { ClientProvider } from '../data/queries'
import { EnrollDialog } from './EnrollDialog'

function setup(scenario: ScenarioId = 'downloads') {
  const client = createMockClient(scenario, { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const create = vi.spyOn(client, 'createEnrollment')
  const poll = vi.spyOn(client, 'getEnrollment')
  const renderDialog = async () => {
    render(
      <ClientProvider client={client}>
        <EnrollDialog onClose={() => {}} />
      </ClientProvider>,
    )
    await screen.findByLabelText('在终端运行')
  }
  return { client, create, poll, renderDialog }
}

describe('device setup downloads', () => {
  it.each([
    ['macOS', 'darwin-arm64', 'a'],
    ['Linux', 'linux-x64', 'b'],
  ] as const)('offers %s downloads and nonsecret login commands for the current center', async (os, target, hash) => {
    const user = userEvent.setup()
    const f = setup()
    await f.renderDialog()
    await user.click(screen.getByRole('radio', { name: os }))
    const file = `baton-v0.1.0-${target}.tar.gz`
    const link = screen.getByRole('link', { name: `下载命令行工具 · ${target.endsWith('x64') ? 'x64' : 'arm64'}` })
    expect(link).toHaveAttribute('href', `${window.location.origin}/downloads/${file}`)
    expect(link).toHaveAttribute('download', file)
    expect(screen.getByText(`SHA-256: ${hash.repeat(64)}`)).toBeInTheDocument()
    expect(screen.getAllByText(/v0.1.0 · \d+(\.\d+)? MB/).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('在终端下载').textContent).toBe(
      `curl -fL -O '${window.location.origin}/downloads/${file}'`,
    )
    expect(screen.getByLabelText('在终端运行').textContent).toBe(
      `tar xzf '${file}' && cd 'baton-v0.1.0-${target}' &&\n./batond login --coordinator '${window.location.origin}' &&\n./batond service install`,
    )
    expect(document.body.textContent).not.toMatch(/ENROLLMENT_TOKEN|register|reauth|--ca-file|--cacert|curl -k/)
    expect(screen.queryByLabelText('设置码')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('设备名称')).not.toBeInTheDocument()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.poll).not.toHaveBeenCalled()
    if (os === 'macOS')
      expect(screen.getByRole('link', { name: '下载桌面客户端 · arm64' })).toHaveAttribute(
        'href',
        expect.stringContaining('.dmg'),
      )
  })

  it('switches Linux architecture for both terminal commands', async () => {
    const user = userEvent.setup()
    await setup().renderDialog()
    await user.click(screen.getByRole('radio', { name: 'Linux' }))
    await user.click(screen.getByRole('radio', { name: 'arm64' }))
    expect(screen.getByLabelText('在终端下载')).toHaveTextContent('baton-v0.1.0-linux-arm64.tar.gz')
    expect(screen.getByLabelText('在终端运行')).toHaveTextContent("cd 'baton-v0.1.0-linux-arm64'")
  })

  it.each(['downloads', 'noDownloads'] as const)('guides Windows to the desktop app with %s', async (scenario) => {
    const user = userEvent.setup()
    const f = setup(scenario)
    await f.renderDialog()
    await user.click(screen.getByRole('radio', { name: 'Windows' }))
    if (scenario === 'downloads') {
      expect(screen.getByRole('link', { name: '下载桌面客户端 · x64' })).toHaveAttribute(
        'href',
        `${window.location.origin}/downloads/baton-desktop-v0.1.0-win32-x64.exe`,
      )
      expect(screen.getByText(`SHA-256: ${'e'.repeat(64)}`)).toBeInTheDocument()
    }
    expect(screen.getByText(/安装桌面客户端/)).toBeInTheDocument()
    expect(screen.queryByLabelText('在终端运行')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('在终端下载')).not.toBeInTheDocument()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('shows login commands for an existing CLI when downloads are disabled', async () => {
    await setup('noDownloads').renderDialog()
    expect(screen.getByLabelText('在终端运行').textContent).toBe(
      `./batond login --coordinator '${window.location.origin}' &&\n./batond service install`,
    )
    expect(screen.queryByLabelText('在终端下载')).not.toBeInTheDocument()
  })

  it('shows a missing package without a mismatched download command', async () => {
    const user = userEvent.setup()
    const f = setup()
    const manifest = await f.client.getDownloads()
    vi.spyOn(f.client, 'getDownloads').mockResolvedValue({ ...manifest, items: [] })
    render(
      <ClientProvider client={f.client}>
        <EnrollDialog onClose={() => {}} />
      </ClientProvider>,
    )
    await user.click(screen.getByRole('radio', { name: 'Linux' }))
    expect(await screen.findByText('暂无适用于 Linux 的命令行工具下载。')).toBeInTheDocument()
    expect(screen.queryByLabelText('在终端运行')).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Windows' }))
    expect(screen.getByText('暂无适用于 Windows 的桌面客户端下载。')).toBeInTheDocument()
  })

  it('retries a failed download query without issuing a setup code', async () => {
    const user = userEvent.setup()
    const f = setup()
    vi.spyOn(f.client, 'getDownloads').mockRejectedValueOnce(new Error('unavailable'))
    render(
      <ClientProvider client={f.client}>
        <EnrollDialog onClose={() => {}} />
      </ClientProvider>,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载下载信息。')
    expect(screen.queryByLabelText('在终端运行')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByLabelText('在终端运行')).toHaveTextContent('./batond login'))
    expect(f.create).not.toHaveBeenCalled()
  })
})
