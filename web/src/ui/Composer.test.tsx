import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { Composer } from './Composer'

function Example({ onSend }: { onSend: (value: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={() => {
        onSend(value)
        setValue('')
      }}
      placeholder="Message"
    />
  )
}

it('sends typed text on Enter and clears when the page clears the draft', async () => {
  const user = userEvent.setup()
  const onSend = vi.fn()
  render(<Example onSend={onSend} />)
  const input = screen.getByRole('textbox', { name: '消息' })
  await user.type(input, 'Hello there{Enter}')
  expect(onSend).toHaveBeenCalledWith('Hello there')
  expect(input.textContent).toBe('')
})

it('keeps a newline on Shift+Enter without sending', async () => {
  const user = userEvent.setup()
  const onSend = vi.fn()
  render(<Example onSend={onSend} />)
  await user.type(screen.getByRole('textbox', { name: '消息' }), 'one{Shift>}{Enter}{/Shift}')
  expect(onSend).not.toHaveBeenCalled()
})

it('shows a draft restored by the page', () => {
  render(<Composer value="saved draft" onChange={() => {}} onSend={() => {}} placeholder="Message" />)
  expect(screen.getByRole('textbox', { name: '消息' })).toHaveTextContent('saved draft')
})
