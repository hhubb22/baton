import { fireEvent, render, screen } from '@testing-library/react'
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

  it('renders a code block and table without inline style attributes', () => {
    const { container } = render(
      <MessageBody
        body={'```js\nconst x = 1\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |'}
        onOpenPath={() => {}}
      />,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(container.querySelector('[style]')).toBeNull()
  })
})
