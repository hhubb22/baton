import * as stylex from '@stylexjs/stylex'
import { useEffect, useState } from 'react'
import { useResolvedTheme } from '../theme/ThemeProvider'
import type { ThemedToken } from '@pierre/highlights'
import { requestHighlight } from './highlight-worker'

const styles = stylex.create({
  blue: { color: '#005cc5' },
  lightBlue: { color: '#79b8ff' },
  comment: { color: '#6a737d' },
  muted: { color: '#848d97' },
  green: { color: '#22863a' },
  lightGreen: { color: '#85e89d' },
  foreground: { color: '#24292e' },
  lightForeground: { color: '#e1e4e8' },
  purple: { color: '#6f42c1' },
  lightPurple: { color: '#b392f0' },
  red: { color: '#d73a49' },
  lightRed: { color: '#f97583' },
  deepRed: { color: '#b31d28' },
  paleRed: { color: '#fdaeb7' },
  string: { color: '#032f62' },
  lightString: { color: '#dbedff' },
  sky: { color: '#9ecbff' },
  orange: { color: '#e36209' },
  lightOrange: { color: '#ffab70' },
  italic: { fontStyle: 'italic' },
  bold: { fontWeight: 'bold' },
})

const tokenColors: Record<string, stylex.StyleXStyles> = {
  '#005cc5': styles.blue,
  '#79b8ff': styles.lightBlue,
  '#6a737d': styles.comment,
  '#848d97': styles.muted,
  '#22863a': styles.green,
  '#85e89d': styles.lightGreen,
  '#24292e': styles.foreground,
  '#e1e4e8': styles.lightForeground,
  '#6f42c1': styles.purple,
  '#b392f0': styles.lightPurple,
  '#d73a49': styles.red,
  '#f97583': styles.lightRed,
  '#b31d28': styles.deepRed,
  '#fdaeb7': styles.paleRed,
  '#032f62': styles.string,
  '#dbedff': styles.lightString,
  '#9ecbff': styles.sky,
  '#e36209': styles.orange,
  '#ffab70': styles.lightOrange,
}

interface HighlightedLines {
  content: string
  path: string
  theme: 'light' | 'dark'
  lines: ThemedToken[][]
}

export function useHighlightedLines(content: string, path: string, streaming = false) {
  const theme = useResolvedTheme()
  const [result, setResult] = useState<HighlightedLines | null>(null)

  useEffect(() => {
    if (!content || content.length > 256 * 1024) return
    let cancelled = false
    void requestHighlight(content, path, theme, !streaming)
      .then((lines) => {
        if (!lines) return
        if (!cancelled) setResult({ content, path, theme, lines })
      })
      .catch(() => {
        if (!cancelled) setResult(null)
      })
    return () => {
      cancelled = true
    }
  }, [content, path, theme, streaming])

  if (!result || result.path !== path || result.theme !== theme) return null
  if (result.content === content) return result.lines
  if (!content.startsWith(result.content)) return null

  // 高亮结果尚未更新时保留已显示的颜色，新内容先以普通文字显示。
  const [tail = '', ...newLines] = content.slice(result.content.length).split('\n')
  const lines = result.lines.map((line) => [...line])
  if (tail) {
    const last = Math.max(0, lines.length - 1)
    const offset = lines[last]?.reduce((length, token) => length + token.content.length, 0) ?? 0
    lines[last] = [...(lines[last] ?? []), { content: tail, offset }]
  }
  for (const line of newLines) lines.push([{ content: line, offset: 0 }])
  return lines
}

export function HighlightedLine({ line, tokens }: { line: string; tokens: ThemedToken[] | undefined }) {
  if (!tokens || tokens.map((token) => token.content).join('') !== line) return line || ' '
  return tokens.length ? (
    <>
      {tokens.map((token, index) => (
        <span
          key={index}
          {...stylex.props(
            token.color ? tokenColors[token.color.toLowerCase()] : undefined,
            Boolean((token.fontStyle ?? 0) & 1) && styles.italic,
            Boolean((token.fontStyle ?? 0) & 2) && styles.bold,
          )}
        >
          {token.content}
        </span>
      ))}
    </>
  ) : (
    ' '
  )
}
