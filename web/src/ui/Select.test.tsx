import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import { chooseOption } from '../test/select'
import { Select } from './Select'

const list = (...values: string[]) => values.map((value) => ({ value, label: value }))

it('keeps the value when dependent options change and only reports user choices', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const { rerender } = render(<Select aria-label="模型" value="a" options={list('a', 'b')} onChange={onChange} />)
  await user.click(screen.getByRole('combobox', { name: '模型' }))
  await user.keyboard('{Escape}')
  rerender(<Select aria-label="模型" value="c" options={list('c', 'd')} onChange={onChange} />)
  rerender(<Select aria-label="模型" value="c" options={list('e', 'f')} onChange={onChange} />)
  expect(onChange).not.toHaveBeenCalled()
  rerender(<Select aria-label="模型" value="e" options={list('e', 'f')} onChange={onChange} />)
  await chooseOption(user, screen.getByRole('combobox', { name: '模型' }), 'f')
  expect(onChange.mock.calls).toEqual([['f']])
})

it('finds grouped options and skips empty groups', async () => {
  const user = userEvent.setup()
  render(
    <Select
      aria-label="来源"
      value="a"
      groups={[
        { label: '订阅', options: list('a') },
        { label: 'API 连接', options: [] },
      ]}
      onChange={() => undefined}
    />,
  )
  await user.click(screen.getByRole('combobox', { name: '来源' }))
  expect(await screen.findByText('订阅')).toBeInTheDocument()
  expect(screen.queryByText('API 连接')).not.toBeInTheDocument()
})
