import { FileDiff, type FileDiffMetadata, type FileDiffOptions } from '@pierre/diffs/react'
import { THEME_CSS_ATTRIBUTE } from '@pierre/diffs'
import { useEffect, useRef, type RefObject } from 'react'

// Diffs 的 Shadow DOM 使用运行时主题和行布局。通过 CSSOM 应用这些样式，兼容只允许同源样式表的 CSP。
function useDiffStyles(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = ref.current?.querySelector('diffs-container')?.shadowRoot
    if (!root) return
    const theme = new CSSStyleSheet()
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, theme]
    const applied = new WeakMap<Element, string>()
    let themeText = ''
    let frame = 0

    const sync = () => {
      frame = 0
      const themeNode = root.querySelector<HTMLStyleElement>(`style[${THEME_CSS_ATTRIBUTE}]`)
      if (!themeNode || themeNode.sheet) return
      const nextTheme = themeNode.textContent ?? ''
      if (nextTheme !== themeText) {
        theme.replaceSync(nextTheme)
        themeText = nextTheme
      }
      for (const element of root.querySelectorAll<HTMLElement>('[style]')) {
        const raw = element.getAttribute('style') ?? ''
        if (applied.get(element) === raw) continue
        const properties = raw.split(';').flatMap((entry) => {
          const colon = entry.indexOf(':')
          if (colon < 1) return []
          const name = entry.slice(0, colon).trim()
          const value = entry.slice(colon + 1).trim()
          if (
            (!name.startsWith('--diffs-') && name !== 'grid-row' && name !== 'grid-column') ||
            /[{}\\]|url\s*\(/i.test(value)
          )
            return []
          return [[name, value] as const]
        })
        element.removeAttribute('style')
        for (const [name, value] of properties) element.style.setProperty(name, value)
        applied.set(element, element.getAttribute('style') ?? '')
      }
    }
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(sync)
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style'],
    })
    sync()
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== theme)
    }
  }, [ref])
}

export function DiffSurface({
  file,
  options,
}: {
  file: FileDiffMetadata
  options: FileDiffOptions<undefined, undefined>
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDiffStyles(ref)
  return (
    <div ref={ref}>
      <FileDiff fileDiff={file} options={options} />
    </div>
  )
}
