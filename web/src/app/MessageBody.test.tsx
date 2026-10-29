import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vite-plus/test'
import { MessageBody } from './MessageBody'

describe('MessageBody', () => {
  it('renders Markdown and opens inline absolute paths', () => {
    const open = vi.fn()
    render(
      <MessageBody
        body={'# Title\n\n**Bold** and `/tmp/file`\n\n- One\n- Two\n\n```js\nconst x = 1\n```'}
        onOpenPath={open}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    expect(screen.getByText('Bold').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '/tmp/file' }))
    expect(open).toHaveBeenCalledWith('/tmp/file')
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
  })

  it('does not load images or unsafe links and skips raw HTML', () => {
    const { container } = render(
      <MessageBody
        body={'![image](https://example.com/a.png)\n\n[bad](javascript:alert%281%29)\n\n<script>alert(1)</script>'}
        onOpenPath={() => {}}
      />,
    )
    expect(container.querySelector('img, script, a')).not.toBeInTheDocument()
  })

  it('renders emphasis next to Chinese punctuation and block math', () => {
    const { container } = render(<MessageBody body={'这是**重点**，请看。\n\n$$\nx^2\n$$'} onOpenPath={() => {}} />)
    expect(screen.getByText('重点').tagName).toBe('STRONG')
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('renders a code block and table', () => {
    const { container } = render(
      <MessageBody
        body={'```js\nconst x = 1\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |'}
        onOpenPath={() => {}}
      />,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制代码' })).toBeInTheDocument()
    expect(container.querySelector('pre')).toHaveTextContent('const x = 1')
  })

  it('copies the original fenced code', async () => {
    const user = userEvent.setup()
    render(<MessageBody body={'```ts\nconst answer = 42\n```'} onOpenPath={() => {}} />)
    await user.click(screen.getByRole('button', { name: '复制代码' }))
    expect(await navigator.clipboard.readText()).toBe('const answer = 42')
    expect(screen.getByRole('button', { name: '已复制代码' })).toBeInTheDocument()
  })

  it('previews a Mermaid diagram locally and keeps its source available', async () => {
    const user = userEvent.setup()
    const source = 'graph LR\n  A[Start] --> B[Done]'
    render(<MessageBody body={`\`\`\`mermaid\n${source}\n\`\`\``} onOpenPath={() => {}} />)
    const diagram = await screen.findByRole('img', { name: '图表' })
    expect(diagram.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    await user.click(screen.getByRole('button', { name: '源码' }))
    expect(screen.getByLabelText('代码块')).toHaveTextContent('A[Start] --> B[Done]')
    await user.click(screen.getByRole('button', { name: '复制代码' }))
    expect(await navigator.clipboard.readText()).toBe(source)
  })

  it('does not include external links in generated diagrams', async () => {
    render(
      <MessageBody
        body={'```mermaid\ngraph LR\n  A[Start] --> B[Done]\n  click A "https://example.com"\n```'}
        onOpenPath={() => {}}
      />,
    )
    const diagram = await screen.findByRole('img', { name: '图表' })
    expect(decodeURIComponent(diagram.getAttribute('src') ?? '')).not.toContain('https://example.com')
  })
})

it('reveals an appended response gradually and finishes it after streaming ends', async () => {
  const open = vi.fn()
  const { container, rerender } = render(<MessageBody body="Hello" streaming onOpenPath={open} />)
  const root = container.firstChild
  await waitFor(() => expect(container.querySelector('.streamdown-animated')).toBeInTheDocument())
  rerender(<MessageBody body="Hello world 🌏 again" streaming onOpenPath={open} />)
  expect(container).not.toHaveTextContent('Hello world 🌏 again')
  rerender(<MessageBody body="Hello world 🌏 again" onOpenPath={open} />)
  await waitFor(() => expect(container).toHaveTextContent('Hello world 🌏 again'))
  expect(container.firstChild).toBe(root)
  expect(container.querySelector('.streamdown-animated')).toBeInTheDocument()
})

it('preserves the code block when streaming finishes and defers Mermaid rendering', async () => {
  const source = 'graph LR\n  A[Start] --> B[Done]'
  const body = `\`\`\`mermaid\n${source}\n\`\`\``
  const { rerender } = render(<MessageBody body={body} streaming onOpenPath={() => {}} />)
  const code = await screen.findByLabelText('代码块')
  const copy = screen.getByRole('button', { name: '复制代码' })
  expect(code).toHaveTextContent('A[Start] --> B[Done]')
  expect(screen.queryByRole('img', { name: '图表' })).not.toBeInTheDocument()
  rerender(<MessageBody body={body} onOpenPath={() => {}} />)
  expect(screen.getByRole('button', { name: '复制代码' })).toBe(copy)
  expect(await screen.findByRole('img', { name: '图表' })).toBeInTheDocument()
})

it('keeps selected text stable while the reply continues streaming', async () => {
  const { container, rerender } = render(<MessageBody body="First" streaming onOpenPath={() => {}} />)
  await waitFor(() => expect(container.querySelector('.streamdown-animated p')).toHaveTextContent('First'))
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(container.querySelector('.streamdown-animated p')!)
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  rerender(<MessageBody body="First and more" streaming onOpenPath={() => {}} />)
  expect(container).not.toHaveTextContent('and more')
  selection.removeAllRanges()
  fireEvent(document, new Event('selectionchange'))
  await waitFor(() => expect(container).toHaveTextContent('First and more'))
})
