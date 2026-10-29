import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import { modelThinking, ThinkingMenu } from './ThinkingMenu'

it('shows only the model choices and returns the upstream option ID and value', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <ThinkingMenu
      capability={{
        id: 'reasoningEffort',
        options: [
          { id: 'medium', label: 'Medium', is_default: true },
          { id: 'high', label: 'High' },
        ],
      }}
      onSelect={onSelect}
    />,
  )
  await user.click(screen.getByRole('button', { name: '思考强度：默认' }))
  expect(await screen.findByRole('menuitem', { name: /中/ })).toHaveTextContent('默认')
  await user.click(screen.getByRole('menuitem', { name: '高' }))
  expect(onSelect).toHaveBeenCalledWith({ id: 'reasoningEffort', value: 'high' })
})

it('explains when the model does not report thinking choices', async () => {
  const user = userEvent.setup()
  render(<ThinkingMenu onSelect={() => {}} />)
  await user.click(screen.getByRole('button', { name: '思考强度：默认' }))
  expect(await screen.findByText('此模型未提供思考强度选项')).toBeInTheDocument()
})

it('does not mistake inherited object properties for model capabilities', () => {
  expect(modelThinking({ modelThinking: {} } as import('../data/types').DeviceAgent, '__proto__')).toBeUndefined()
  expect(modelThinking({ modelThinking: {} } as import('../data/types').DeviceAgent, 'constructor')).toBeUndefined()
})

it('explains that steering uses the active reply settings', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<ThinkingMenu lockedReason="插话沿用当前回复的思考强度" onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: '思考强度：当前回复' }))
  expect(await screen.findByText('插话沿用当前回复的思考强度')).toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})
