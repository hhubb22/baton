import { canUseWASM, parsePatchFiles } from '@pierre/diffs'
import * as stylex from '@stylexjs/stylex'
import { useMemo, type ReactNode } from 'react'
import { useResolvedTheme } from '../theme/ThemeProvider'
import { DiffSurface } from './DiffSurface'

const styles = stylex.create({
  root: { minWidth: 0, maxHeight: '400px', overflow: 'auto' },
})

export function ChangeDiff({ patch, path, fallback }: { patch: string; path?: string; fallback: ReactNode }) {
  const theme = useResolvedTheme()
  const files = useMemo(() => {
    const name = (path?.split(/[\\/]/).pop() || 'file.txt').replace(/[\r\n\t]/g, '_')
    const input = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(patch) ? `--- ${name}\n+++ ${name}\n${patch}` : patch
    if (!/^(?:diff --git |--- )/.test(input)) return null
    try {
      const parsed = parsePatchFiles(input, undefined, true).flatMap((item) => item.files)
      return parsed.length && parsed.every((file) => file.hunks.length > 0) ? parsed : null
    } catch {
      return null
    }
  }, [patch, path])
  const options = useMemo(
    () => ({
      theme: { light: 'github-light', dark: 'github-dark' },
      themeType: theme,
      preferredHighlighter: canUseWASM() ? ('highlights' as const) : ('shiki-js' as const),
      diffStyle: 'unified' as const,
      overflow: 'wrap' as const,
      disableFileHeader: true,
    }),
    [theme],
  )
  if (!files) return fallback
  return (
    <div aria-label="File changes" {...stylex.props(styles.root)}>
      {files.map((file, index) => (
        <DiffSurface key={index} file={file} options={options} />
      ))}
    </div>
  )
}
