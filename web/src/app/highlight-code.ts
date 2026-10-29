import type { ThemedToken } from '@pierre/highlights'

export async function highlightCode(
  content: string,
  path: string,
  theme: 'light' | 'dark',
): Promise<ThemedToken[][] | null> {
  const themeModule =
    theme === 'dark'
      ? import('@pierre/highlights/themes/github-dark')
      : import('@pierre/highlights/themes/github-light')
  const [highlights, diffs, colors] = await Promise.all([
    import('@pierre/highlights'),
    import('@pierre/diffs'),
    themeModule,
  ])
  const lang = diffs.getFiletypeFromFileName(path)
  if (!highlights.isSupportedLanguage(lang)) return null
  return highlights.codeToTokens(content, { lang, theme: colors.default, tokenizeMaxLineLength: 1000 }).tokens
}
