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

it('bounds a floating pane to its container without overwriting the preferred width', () => {
  localStorage.setItem('test.pane.width', '600')
  render(
    <ResizablePane
      label="Floating"
      storageKey="test.pane.width"
      defaultWidth={320}
      min={280}
      max={800}
      reserve={400}
      floating
    >
      <div>Overview</div>
    </ResizablePane>,
  )
  const handle = screen.getByRole('separator', { name: 'Floating' })
  const parent = handle.parentElement!.parentElement!
  const resize = (width: number) => {
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: width })
    fireEvent(window, new Event('resize'))
  }
  resize(1200)
  expect(handle).toHaveAttribute('aria-valuenow', '480')
  resize(800)
  expect(handle).toHaveAttribute('aria-valuenow', '320')
  expect(localStorage.getItem('test.pane.width')).toBe('600')
  resize(1600)
  expect(handle).toHaveAttribute('aria-valuenow', '600')
  resize(800)
  fireEvent.keyDown(handle, { key: 'End' })
  expect(handle).toHaveAttribute('aria-valuenow', '320')
  resize(400)
  expect(handle).toHaveAttribute('aria-valuenow', '384')
  resize(1200)
  expect(handle).toHaveAttribute('aria-valuenow', '320')
})
