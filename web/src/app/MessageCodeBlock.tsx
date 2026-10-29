import * as stylex from '@stylexjs/stylex'
import { createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { HighlightedLine, useHighlightedLines } from './CodeHighlight'
import { MessageDiagram } from './MessageDiagram'
import { copyText } from './SelectionMenu'

const styles = stylex.create({
  root: {
    minWidth: 0,
    maxWidth: '100%',
    marginBottom: space.md,
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.codeBorder,
    borderRadius: radius.md,
    backgroundColor: colors.code,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: '36px',
    paddingInline: space.md,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.codeBorder,
    color: colors.muted,
  },
  copy: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.xs,
    padding: space.xs,
    borderWidth: 0,
    borderRadius: radius.sm,
    color: { default: colors.muted, ':hover': colors.text },
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    cursor: 'pointer',
  },
  pre: {
    margin: 0,
    padding: space.md,
    overflowX: 'auto',
    whiteSpace: 'pre',
    fontFamily: fonts.mono,
    fontSize: '12px',
    lineHeight: 1.6,
  },
})

export const MessageStreamingContext = createContext(false)

function HighlightedCode({ value, language }: { value: string; language: string }) {
  const streaming = useContext(MessageStreamingContext)
  const highlighted = useHighlightedLines(value, `code.${language}`, streaming)
  const lines = value.split('\n')
  return (
    <code>
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 && '\n'}
          {line && <HighlightedLine line={line} tokens={highlighted?.[index]} />}
        </span>
      ))}
    </code>
  )
}

export function MessageCodeBlock({ children }: { children?: ReactNode }) {
  const [copyStatus, setCopyStatus] = useState<'copied' | 'error' | null>(null)
  const [showSource, setShowSource] = useState(false)
  useEffect(() => {
    if (!copyStatus) return
    const timer = window.setTimeout(() => setCopyStatus(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copyStatus])
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>
  const value = typeof children.props.children === 'string' ? children.props.children.replace(/\n$/, '') : null
  if (value === null) return <pre>{children}</pre>
  const language = children.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? ''

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(text.caption, styles.header)}>
        <span>{language || 'Code'}</span>
        <div>
          {language === 'mermaid' && (
            <button
              type="button"
              onClick={() => setShowSource(!showSource)}
              {...stylex.props(text.caption, styles.copy, focusRing.ring)}
            >
              {showSource ? 'Preview' : 'Source'}
            </button>
          )}
          <button
            type="button"
            aria-label={copyStatus === 'copied' ? 'Copied code' : 'Copy code'}
            onClick={() => {
              void copyText(value).then(
                () => setCopyStatus('copied'),
                () => setCopyStatus('error'),
              )
            }}
            {...stylex.props(text.caption, styles.copy, focusRing.ring)}
          >
            <Icon name={copyStatus === 'copied' ? 'check' : 'copy'} size={12} />
            {copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Copy failed' : 'Copy'}
          </button>
        </div>
      </div>
      {language === 'mermaid' && !showSource ? (
        <MessageDiagram source={value} />
      ) : (
        <pre aria-label="Code block" tabIndex={0} {...stylex.props(styles.pre, focusRing.ring)}>
          <HighlightedCode value={value} language={language} />
        </pre>
      )}
    </div>
  )
}
