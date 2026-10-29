import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vite-plus/test'
import { HighlightedLine, useHighlightedLines } from './CodeHighlight'

function Preview({ content, path }: { content: string; path: string }) {
  const lines = useHighlightedLines(content, path)
  return (
    <div data-testid="code">
      <HighlightedLine line={content} tokens={lines?.[0]} />
    </div>
  )
}

it('highlights supported code without changing the text', async () => {
  const content = 'const answer = 42'
  render(<Preview content={content} path="answer.ts" />)
  const code = await screen.findByTestId('code')
  await vi.waitFor(() => expect(code.querySelectorAll('span').length).toBeGreaterThan(1))
  expect(code).toHaveTextContent(content)
})

it('keeps the original text if tokens do not match', () => {
  render(<HighlightedLine line="original" tokens={[{ content: 'different', offset: 0 }]} />)
  expect(screen.getByText('original')).toBeInTheDocument()
})

it('keeps existing highlighting while appended code is being highlighted', async () => {
  const { rerender } = render(<Preview content="const answer = 42" path="answer.ts" />)
  const code = screen.getByTestId('code')
  await vi.waitFor(() => expect(code.querySelectorAll('span').length).toBeGreaterThan(1))
  rerender(<Preview content="const answer = 42 + 1" path="answer.ts" />)
  expect(code.querySelectorAll('span').length).toBeGreaterThan(1)
  expect(code).toHaveTextContent('const answer = 42 + 1')
})
