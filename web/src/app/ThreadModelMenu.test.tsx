import { render, screen, within } from '@testing-library/react'
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

it('accepts a trimmed custom model ID and keeps it selected when reopening the menu', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const { rerender } = render(
    <ThreadModelMenu agents={[agent]} choice={null} label="Choose model" onSelect={onSelect} />,
  )
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Enter model ID…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Choose Pi model' })
  await user.click(within(dialog).getByRole('button', { name: 'Use model' }))
  expect(await screen.findByText('Enter a model ID.')).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText('Model ID'), '  provider/custom  ')
  await user.keyboard('{Enter}')
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

it('offers manual model entry when discovery returns an empty catalog', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<ThreadModelMenu agents={[{ ...agent, models: [] }]} choice={null} label="Choose model" onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: 'Choose model' }))
  expect(await screen.findByRole('menuitem', { name: 'Default model' })).toBeInTheDocument()
  await user.click(screen.getByRole('menuitem', { name: 'Enter model ID…' }))
  const input = await screen.findByLabelText('Model ID')
  await user.type(input, 'provider/custom{Enter}')
  expect(onSelect).toHaveBeenCalledWith({ agent: 'pi', model: 'provider/custom' })
})

it('explains unsupported model switching without offering a manual entry', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <ThreadModelMenu
      agents={[agent]}
      choice={{ agent: 'pi', model: 'provider/current' }}
      label="Current model"
      lockedReason="Pi cannot switch models in this chat."
      onSelect={onSelect}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Current model' }))
  expect(await screen.findByText('Pi cannot switch models in this chat.')).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Enter model ID…' })).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})
