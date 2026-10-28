import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Composer } from './Composer'

afterEach(() => vi.restoreAllMocks())

it('expands and shrinks with the message and limits the input height', () => {
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLTextAreaElement,
  ) {
    return Math.max(24, this.value.split('\n').length * 24)
  })
  function Example() {
    const [value, setValue] = useState('')
    return <Composer value={value} onChange={setValue} onSend={() => {}} placeholder="Message" />
  }
  render(<Example />)
  const input = screen.getByRole('textbox', { name: 'Message' })
  expect(input).toHaveStyle({ height: '24px' })
  fireEvent.change(input, { target: { value: 'one\ntwo\nthree' } })
  expect(input).toHaveStyle({ height: '72px' })
  expect(input).toHaveStyle({ overflowY: 'hidden' })
  fireEvent.change(input, { target: { value: Array(20).fill('line').join('\n') } })
  expect(input).toHaveStyle({ height: '240px' })
  expect(input).toHaveStyle({ overflowY: 'auto' })
  fireEvent.change(input, { target: { value: '' } })
  expect(input).toHaveStyle({ height: '24px' })
  expect(input).toHaveStyle({ overflowY: 'hidden' })
})
