import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vite-plus/test'
import { MessageActions } from './MessageActions'

it('copies the full reply and confirms the action', async () => {
  const user = userEvent.setup()
  render(<MessageActions body={'**Result**\n\nCompleted.'} />)
  await user.click(screen.getByRole('button', { name: '复制回复' }))
  expect(await navigator.clipboard.readText()).toBe('**Result**\n\nCompleted.')
  expect(screen.getByRole('button', { name: '已复制回复' })).toBeInTheDocument()
})

it('labels the thread action and confirms copying its reply', async () => {
  const user = userEvent.setup()
  render(<MessageActions body="Thread reply" thread />)
  await user.click(screen.getByRole('button', { name: '复制回复' }))
  expect(await navigator.clipboard.readText()).toBe('Thread reply')
  expect(screen.getByRole('status')).toHaveTextContent('已复制')
})
