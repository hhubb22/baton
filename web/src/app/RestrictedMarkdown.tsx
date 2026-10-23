import * as stylex from '@stylexjs/stylex'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fonts, weight } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    color: colors.text,
    overflowWrap: 'anywhere',
  },
  paragraph: { margin: 0 },
  strong: { fontWeight: weight.semibold },
  code: {
    fontFamily: fonts.mono,
    fontSize: '0.93em',
    paddingInline: space.xxs,
    borderRadius: radius.inner,
    backgroundColor: colors.code,
  },
  codeBlock: {
    boxSizing: 'border-box',
    minWidth: 0,
    maxWidth: '100%',
    margin: 0,
    padding: space.md,
    overflowX: 'auto',
    whiteSpace: 'pre',
    overflowWrap: 'normal',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.codeBorder,
    borderRadius: radius.sm,
    backgroundColor: colors.code,
  },
  list: { margin: 0, paddingLeft: space.xl, minWidth: 0 },
  unordered: { listStyleType: 'disc' },
  ordered: { listStyleType: 'decimal' },
  tableScroll: {
    boxSizing: 'border-box',
    minWidth: 0,
    maxWidth: '100%',
    overflowX: 'auto',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: radius.sm,
  },
  table: { width: '100%', borderCollapse: 'collapse', overflowWrap: 'normal' },
  cell: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    textAlign: 'start',
  },
  header: { fontWeight: weight.semibold, backgroundColor: colors.subtle },
  left: { textAlign: 'left' },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
  link: { color: colors.link, textDecoration: 'underline' },
})

const allowedElements = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
]

const httpsUrl: UrlTransform = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname ? url.href : undefined
  } catch {
    return undefined
  }
}

function alignment(align: string | null | undefined) {
  return align === 'left' ? styles.left : align === 'center' ? styles.center : align === 'right' ? styles.right : null
}

const components: Components = {
  p: ({ children }) => <p {...stylex.props(styles.paragraph)}>{children}</p>,
  strong: ({ children }) => <strong {...stylex.props(styles.strong)}>{children}</strong>,
  code: ({ children }) => <code {...stylex.props(styles.code)}>{children}</code>,
  pre: ({ children }) => (
    <pre aria-label="Code block" tabIndex={0} {...stylex.props(styles.codeBlock, focusRing.ring)}>
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul {...stylex.props(styles.list, styles.unordered)}>{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} {...stylex.props(styles.list, styles.ordered)}>
      {children}
    </ol>
  ),
  table: ({ children }) => (
    <div role="region" aria-label="Table" tabIndex={0} {...stylex.props(styles.tableScroll, focusRing.ring)}>
      <table {...stylex.props(styles.table)}>{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th scope="col" {...stylex.props(styles.cell, styles.header, alignment(style?.textAlign))}>
      {children}
    </th>
  ),
  td: ({ children, style }) => <td {...stylex.props(styles.cell, alignment(style?.textAlign))}>{children}</td>,
  a: ({ children, href, title }) =>
    href ? (
      <a
        href={href}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
        {...stylex.props(styles.link, focusRing.ring)}
      >
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
}

export function RestrictedMarkdown({ body }: { body: string }) {
  return (
    <div {...stylex.props(text.body, styles.body)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={allowedElements}
        unwrapDisallowed
        skipHtml
        urlTransform={httpsUrl}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}
