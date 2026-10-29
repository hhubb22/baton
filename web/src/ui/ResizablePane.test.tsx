import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vite-plus/test'
import { ResizablePane } from './ResizablePane'

afterEach(() => localStorage.removeItem('test.pane.width'))

it('adjusts with the keyboard, respects limits, and restores the saved width', () => {
  const pane = () => (
    <ResizablePane label="Resize test" storageKey="test.pane.width" defaultWidth={248} min={200} max={400} reserve={0}>
      <div>Content</div>
    </ResizablePane>
  )
  const view = render(pane())
  const handle = screen.getByRole('separator', { name: 'Resize test' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle).toHaveAttribute('aria-valuenow', '258')
  fireEvent.keyDown(handle, { key: 'End' })
  expect(handle).toHaveAttribute('aria-valuenow', '400')
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle).toHaveAttribute('aria-valuenow', '400')
  view.unmount()
  render(pane())
  expect(screen.getByRole('separator', { name: 'Resize test' })).toHaveAttribute('aria-valuenow', '400')
})

it('adjusts the right panel in the direction of its left edge', () => {
  render(
    <ResizablePane
      label="Resize right"
      storageKey="test.pane.width"
      defaultWidth={320}
      min={280}
      max={800}
      reserve={0}
      edge="left"
    >
      <div>Content</div>
    </ResizablePane>,
  )
  const handle = screen.getByRole('separator', { name: 'Resize right' })
  fireEvent.keyDown(handle, { key: 'ArrowLeft' })
  expect(handle).toHaveAttribute('aria-valuenow', '330')
})
