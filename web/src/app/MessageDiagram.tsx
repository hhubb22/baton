import * as stylex from '@stylexjs/stylex'
import { useEffect, useState } from 'react'
import { useResolvedTheme } from '../theme/ThemeProvider'
import { colors, space } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'

const styles = stylex.create({
  preview: { padding: space.lg, overflowX: 'auto', backgroundColor: colors.surface },
  image: { display: 'block', maxWidth: '100%', height: 'auto', marginInline: 'auto' },
  source: { margin: 0, padding: space.md, overflowX: 'auto', whiteSpace: 'pre', fontSize: '12px', lineHeight: 1.6 },
})
const cache = new Map<string, string>()

export function MessageDiagram({ source }: { source: string }) {
  const theme = useResolvedTheme()
  const key = `${theme}\0${source}`
  const [result, setResult] = useState<{ key: string; url: string } | null>(null)
  const [failedImage, setFailedImage] = useState<string | null>(null)
  useEffect(() => {
    if (cache.has(key)) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void import('pele')
        .then(({ render }) => {
          const { svg } = render(source, { links: false, images: false, responsive: false })
          const palette =
            theme === 'dark'
              ? '--pele-bg:#1c1c1d;--pele-fg:#eeeeef;--pele-muted:#aeb0b5;--pele-line:#aeb0b5;--pele-surface:#252627;--pele-surface-alt:#343536;--pele-border:#74767b;--pele-accent:#91a5ff;'
              : '--pele-bg:#fff;--pele-fg:#1b1b1b;--pele-muted:#5c5c5e;--pele-line:#5c5c5e;--pele-surface:#f4f4f5;--pele-surface-alt:#e9e9ea;--pele-border:#9b9da2;--pele-accent:#5e6ac1;'
          const themed = svg.replace('style="', `style="${palette}`)
          const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`
          cache.set(key, url)
          while (cache.size > 32) cache.delete(cache.keys().next().value!)
          if (!cancelled) setResult({ key, url })
        })
        .catch(() => {
          if (!cancelled) setResult(null)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key, source, theme])
  const url = cache.get(key) ?? (result?.key === key ? result.url : undefined)
  if (!url || failedImage === key) {
    return (
      <pre aria-label="Code block" tabIndex={0} {...stylex.props(styles.source, focusRing.ring)}>
        <code>{source}</code>
      </pre>
    )
  }
  return (
    <div {...stylex.props(styles.preview)}>
      <img src={url} alt="Diagram" onError={() => setFailedImage(key)} {...stylex.props(styles.image)} />
    </div>
  )
}
