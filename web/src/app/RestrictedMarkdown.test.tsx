import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vite-plus/test'
import { RestrictedMarkdown } from './RestrictedMarkdown'

describe('RestrictedMarkdown', () => {
  it('renders emphasis, inline code, paragraphs and line breaks', () => {
    const { container } = render(
      <RestrictedMarkdown body={'**Important** and *careful* with `a < b`  \nnext line\n\nAnother paragraph.'} />,
    )

    expect(screen.getByText('Important').tagName).toBe('STRONG')
    expect(screen.getByText('careful').tagName).toBe('EM')
    expect(screen.getByText('a < b').tagName).toBe('CODE')
    expect(container.querySelector('br')).toBeInTheDocument()
    expect(container.querySelectorAll('p')).toHaveLength(2)
  })

  it('renders fenced and indented code literally', () => {
    const { container } = render(
      <RestrictedMarkdown
        body={'```html\n<script>alert("x")</script>\n**literal**\n```\n\n    indented <img src="x">'}
      />,
    )

    const blocks = screen.getAllByLabelText('代码块')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].querySelector('code')?.textContent).toBe('<script>alert("x")</script>\n**literal**\n')
    expect(blocks[1].querySelector('code')?.textContent).toBe('indented <img src="x">\n')
    expect(container.querySelector('script, img, strong')).not.toBeInTheDocument()
  })

  it('renders nested unordered lists and ordered lists with their starting number', () => {
    render(<RestrictedMarkdown body={'- First\n  - Nested **item**\n- Second\n\n3. Third\n4. Fourth'} />)

    const lists = screen.getAllByRole('list')
    expect(lists.map((list) => list.tagName)).toEqual(['UL', 'UL', 'OL'])
    expect(within(lists[0]).getAllByRole('listitem')).toHaveLength(3)
    expect(within(lists[1]).getByText('item').tagName).toBe('STRONG')
    expect(lists[2]).toHaveAttribute('start', '3')
    expect(within(lists[2]).getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders GFM tables with inline formatting', () => {
    render(
      <RestrictedMarkdown body={'| Name | Value | Status |\n| :--- | :---: | ---: |\n| **One** | `two` | *ready* |'} />,
    )

    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['Name', 'Value', 'Status'])
    expect(headers.every((header) => header.getAttribute('scope') === 'col')).toBe(true)
    expect(within(table).getAllByRole('cell')).toHaveLength(3)
    expect(within(table).getByText('One').tagName).toBe('STRONG')
    expect(within(table).getByText('two').tagName).toBe('CODE')
    expect(within(table).getByText('ready').tagName).toBe('EM')
  })

  it('opens HTTP, HTTPS and mailto inline, reference and automatic links safely', () => {
    render(
      <RestrictedMarkdown
        body={
          '[**Docs**](https://example.com/docs?q=one&x=two#part "Documentation")\n\n' +
          '[Reference][guide]\n\n[guide]: HTTPS://EXAMPLE.COM/guide\n\n' +
          '<https://example.com/auto>\n\nhttps://example.com/plain\n\n' +
          '[Local](http://localhost:5173/docs)\n\n[Email](mailto:user@example.com)'
        }
      />,
    )

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.com/docs?q=one&x=two#part',
      'https://example.com/guide',
      'https://example.com/auto',
      'https://example.com/plain',
      'http://localhost:5173/docs',
      'mailto:user@example.com',
    ])
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('title', 'Documentation')
    expect(screen.getByText('Docs').tagName).toBe('STRONG')
  })

  it.each([
    'http://',
    'mailto:',
    'javascript:alert%281%29',
    'JaVaScRiPt:alert%281%29',
    'jav&#x61;script:alert%281%29',
    'java&#x09;script:alert%281%29',
    'java&#x0a;script:alert%281%29',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox%281%29',
    'file:///etc/passwd',
    'ftp://example.com/file',
    '//example.com/path',
    '/relative',
    './relative',
    '#fragment',
    'https://',
    'https://[invalid]',
    'https://example.com:invalid',
    'https%3A%2F%2Fexample.com',
    '',
  ])('keeps the label and disables an unsafe or invalid link: %s', (href) => {
    const { container } = render(<RestrictedMarkdown body={`[**Keep this label**](${href})`} />)

    expect(screen.getByText('Keep this label').tagName).toBe('STRONG')
    expect(container.querySelector('a, [href]')).not.toBeInTheDocument()
  })

  it('applies the protocol boundary to reference links and allows GFM web and email links', () => {
    const { container } = render(
      <RestrictedMarkdown
        body={
          '[Reference][unsafe]\n\n[unsafe]: javascript:alert%281%29\n\n' +
          '<http://example.com>\n\nhttp://example.com/plain\n\nwww.example.com\n\nuser@example.com'
        }
      />,
    )

    expect(screen.getByText('Reference')).toBeInTheDocument()
    expect(container).toHaveTextContent('http://example.com')
    expect(container).toHaveTextContent('user@example.com')
    expect(screen.getByText('Reference').closest('a')).toBeNull()
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'http://example.com/',
      'http://example.com/plain',
      'http://www.example.com/',
      'mailto:user@example.com',
    ])
  })

  it('drops raw HTML, event handlers and embedded active content', () => {
    const { container } = render(
      <RestrictedMarkdown
        body={
          'Before <b onclick="alert(1)">readable</b> after.\n\n' +
          '<script>alert(1)</script>\n\n' +
          '<iframe src="https://example.com"></iframe>\n\n' +
          '<svg onload="alert(1)"><a href="javascript:alert(1)">bad</a></svg>\n\n' +
          '<img src="https://example.com/pixel" onerror="alert(1)">\n\n' +
          '<a href="https://example.com">Raw link</a>\n\n' +
          '**Still formatted**'
        }
      />,
    )

    expect(container).toHaveTextContent('Before readable after.')
    expect(screen.getByText('Still formatted').tagName).toBe('STRONG')
    expect(
      container.querySelector('b, script, iframe, svg, img, a, [onclick], [onerror], [onload]'),
    ).not.toBeInTheDocument()
  })

  it('drops inline and reference images, including linked images', () => {
    const { container } = render(
      <RestrictedMarkdown
        body={
          'Before ![Inline secret](https://example.com/pixel) after.\n\n' +
          '![Reference secret][image]\n\n[image]: https://example.com/image\n\n' +
          '[![Linked secret](https://example.com/linked)](javascript:alert%281%29)'
        }
      />,
    )

    expect(container).toHaveTextContent('Before after.')
    expect(container.querySelector('img, [src], a')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('secret')
  })

  it('preserves text from unsupported formatting without adding controls', () => {
    const { container } = render(<RestrictedMarkdown body={'# Heading\n\n~~Removed~~\n\n- [x] Done'} />)

    expect(container).toHaveTextContent('Heading')
    expect(container).toHaveTextContent('Removed')
    expect(container).toHaveTextContent('Done')
    expect(container.querySelector('h1, del, input')).not.toBeInTheDocument()
  })

  it('preserves long code and wide tables in keyboard-accessible containers', () => {
    const longValue = 'value'.repeat(400)
    render(<RestrictedMarkdown body={`\`\`\`\n${longValue}\n\`\`\`\n\n| Value |\n| --- |\n| ${longValue} |`} />)

    const code = screen.getByLabelText('代码块')
    const tableScroll = screen.getByRole('region', { name: '表格' })
    expect(code.textContent).toBe(`${longValue}\n`)
    expect(within(tableScroll).getByRole('cell').textContent).toBe(longValue)
    expect(code).toHaveAttribute('tabindex', '0')
    expect(tableScroll).toHaveAttribute('tabindex', '0')
  })

  it('handles an empty body and updates when the body changes', () => {
    const { container, rerender } = render(<RestrictedMarkdown body="" />)
    expect(container.firstElementChild).toBeEmptyDOMElement()

    rerender(<RestrictedMarkdown body="**Updated**" />)
    expect(screen.getByText('Updated').tagName).toBe('STRONG')

    rerender(<RestrictedMarkdown body={'   \n'} />)
    expect(container.textContent?.trim()).toBe('')
    expect(container.querySelector('strong')).not.toBeInTheDocument()
  })
})
