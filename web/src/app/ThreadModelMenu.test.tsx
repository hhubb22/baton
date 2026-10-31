import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import type { DeviceAgent } from '../data/types'
import { ThreadModelMenu } from './ThreadModelMenu'

const agent: DeviceAgent = {
  kind: 'pi',
  status: 'available',
  reason: null,
  version: '1',
  models: ['provider/reported'],
  defaultModel: 'provider/reported',
  abilities: { create: true, queue: true, steer: true, stop: true, resume: true, switchModel: true },
  account: null,
  problem: null,
}

it('accepts a trimmed custom model ID from the search box and keeps it selected when reopening', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const { rerender } = render(
    <ThreadModelMenu agents={[agent]} choice={null} label="Choose model" onSelect={onSelect} />,
  )
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  const search = await screen.findByRole('textbox', { name: '搜索模型' })
  await user.type(search, '  provider/custom  ')
  await user.click(await screen.findByRole('menuitem', { name: '使用 provider/custom' }))
  expect(onSelect).toHaveBeenCalledWith({ agent: 'pi', model: 'provider/custom' })
  rerender(
    <ThreadModelMenu
      agents={[agent]}
      choice={{ agent: 'pi', model: 'provider/custom' }}
      label="Choose model"
      onSelect={onSelect}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  expect(await screen.findByRole('menuitem', { name: 'provider/custom' })).toHaveAttribute('aria-checked', 'true')
})

it('offers manual model entry via Enter when discovery returns an empty catalog', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<ThreadModelMenu agents={[{ ...agent, models: [] }]} choice={null} label="Choose model" onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  expect(await screen.findByRole('menuitem', { name: '默认模型' })).toBeInTheDocument()
  const search = screen.getByRole('textbox', { name: '搜索模型' })
  await user.type(search, '  provider/custom  {Enter}')
  expect(onSelect).toHaveBeenCalledWith({ agent: 'pi', model: 'provider/custom' })
})

it('lists reported Codex models without a manual model entry', async () => {
  const user = userEvent.setup()
  render(
    <ThreadModelMenu
      agents={[{ ...agent, kind: 'codex', models: ['gpt-6.1-sol'] }]}
      choice={null}
      label="Choose model"
      onSelect={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  expect(await screen.findByRole('menuitem', { name: 'gpt-6.1-sol' })).toBeInTheDocument()
  await user.type(screen.getByRole('textbox', { name: '搜索模型' }), 'custom-codex')
  expect(screen.getByText('没有匹配的模型')).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: '使用 custom-codex' })).not.toBeInTheDocument()
})

it('filters models by name, splits provider prefixes, and resets the search when reopened', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <ThreadModelMenu
      agents={[{ ...agent, models: ['provider/alpha', 'provider/beta'] }]}
      choice={null}
      label="Choose model"
      onSelect={onSelect}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  await user.type(await screen.findByRole('textbox', { name: '搜索模型' }), 'beta')
  const item = screen.getByRole('menuitem', { name: 'provider/beta' })
  expect(item).toHaveTextContent('beta')
  expect(item).toHaveTextContent('provider')
  expect(screen.queryByRole('menuitem', { name: 'provider/alpha' })).not.toBeInTheDocument()
  await user.click(item)
  expect(onSelect).toHaveBeenCalledWith({ agent: 'pi', model: 'provider/beta' })
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  expect(await screen.findByRole('textbox', { name: '搜索模型' })).toHaveValue('')
  expect(screen.getByRole('menuitem', { name: 'provider/alpha' })).toBeInTheDocument()
})

it('switches between agents in the sidebar and searches across all agents', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const codex: DeviceAgent = {
    ...agent,
    kind: 'codex',
    models: ['gpt-5.4'],
    defaultModel: 'gpt-5.4',
  }
  const droid: DeviceAgent = {
    ...agent,
    kind: 'droid',
    models: ['claude-sonnet-4-6'],
    defaultModel: 'claude-sonnet-4-6',
  }
  render(
    <ThreadModelMenu
      agents={[codex, agent, droid]}
      choice={{ agent: 'codex', model: 'gpt-5.4' }}
      label="gpt-5.4"
      onSelect={onSelect}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'gpt-5.4' }))
  expect(await screen.findByRole('menuitem', { name: 'gpt-5.4' })).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'claude-sonnet-4-6' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Droid' }))
  expect(await screen.findByRole('menuitem', { name: 'claude-sonnet-4-6' })).toBeInTheDocument()

  await user.type(screen.getByRole('textbox', { name: '搜索模型' }), 'reported')
  expect(await screen.findByRole('menuitem', { name: 'provider/reported' })).toBeInTheDocument()
})

it('explains unsupported model switching without offering a manual entry', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <ThreadModelMenu
      agents={[agent]}
      choice={{ agent: 'pi', model: 'provider/current' }}
      label="Current model"
      lockedReason="Pi cannot switch models in this thread."
      onSelect={onSelect}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Current model' }))
  expect(await screen.findByText('Pi cannot switch models in this thread.')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '搜索模型' })).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})
