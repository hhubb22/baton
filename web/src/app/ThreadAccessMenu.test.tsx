import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import type { DeviceAgent } from '../data/types'
import { ThreadAccessMenu } from './ThreadAccessMenu'

it('offers reported modes and keeps unavailable choices visible with their reason', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const agent = {
    runtimeModes: [
      { id: 'full-access', available: false, reason: '权限检查失败' },
      { id: 'approval-required', available: true },
    ],
  } as DeviceAgent
  render(<ThreadAccessMenu agent={agent} mode="full-access" onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: 'Full access' }))
  expect(await screen.findByText('权限检查失败')).toBeInTheDocument()
  await user.click(screen.getByText('Supervised'))
  expect(onSelect).toHaveBeenCalledWith('approval-required')
})
