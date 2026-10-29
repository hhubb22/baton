const tags = new Set(
  'html head body div span main header footer nav section article aside p br hr h1 h2 h3 h4 h5 h6 ul ol li button input textarea select option label form fieldset legend table thead tbody tr th td svg path rect circle line polyline polygon g defs clipPath image canvas img a pre code blockquote details summary dialog'.split(
    ' ',
  ),
)
const keys = new Set(
  'type source timestamp id parentId nextId previousId node childNodes tagName isSVG isShadow width height x y left top scrollTop scrollLeft initialOffset data adds removes texts attributes positions mousemove pointerType target checked'.split(
    ' ',
  ),
)
export const replayStyleProperties = [
  'display',
  'position',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'padding',
  'gap',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'align-items',
  'align-self',
  'justify-content',
  'overflow',
  'overflow-x',
  'overflow-y',
]
const keywords = new Set(
  'none block inline inline-block flex inline-flex grid inline-grid contents static relative absolute fixed sticky border-box content-box row row-reverse column column-reverse nowrap wrap wrap-reverse stretch center start end flex-start flex-end space-between space-around space-evenly auto hidden scroll visible clip'.split(
    ' ',
  ),
)
const safeStyleValue = (value: string) =>
  value.split(/\s+/).every((part) => keywords.has(part) || /^-?(?:\d+|\d*\.\d+)(?:px|%|em|rem|vh|vw)?$/.test(part))

export function safeReplayStyle(style: string): string {
  return style
    .split(';')
    .flatMap((entry) => {
      const separator = entry.indexOf(':')
      if (separator < 0) return []
      const property = entry.slice(0, separator).trim()
      const value = entry.slice(separator + 1).trim()
      return replayStyleProperties.includes(property) && value && safeStyleValue(value) ? [`${property}:${value}`] : []
    })
    .join(';')
}

// 保留结构、交互和受限的布局样式，遮挡文字并删除 URL 与其他属性。
export function sanitizeReplay(value: unknown, layout?: (id: number) => string | undefined): unknown {
  if (Array.isArray(value))
    return value.map((item) => sanitizeReplay(item, layout)).filter((item) => item !== undefined)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (!value || typeof value !== 'object') return undefined
  const clean: Record<string, unknown> = {}
  const style = 'id' in value && typeof value.id === 'number' ? layout?.(value.id) : undefined
  for (const [key, item] of Object.entries(value)) {
    if (key === 'attributes') {
      if (Array.isArray(item)) {
        clean.attributes = sanitizeReplay(item, layout)
        continue
      }
      const attributes: Record<string, string> = {}
      const candidate =
        style ??
        (item && typeof item === 'object' && 'style' in item && typeof item.style === 'string' ? item.style : '')
      const safe = safeReplayStyle(candidate)
      if (safe) attributes.style = safe
      clean.attributes = attributes
    } else if (key === 'textContent' || key === 'value' || key === 'text') {
      clean[key] = typeof item === 'string' ? item.replace(/\S/g, '*') : ''
    } else if (key === 'tagName') {
      clean.tagName = typeof item === 'string' && tags.has(item) ? item : 'div'
    } else if (keys.has(key)) {
      if (typeof item === 'number' && Number.isFinite(item)) clean[key] = item
      else if (typeof item === 'boolean') clean[key] = item
      else if (item && typeof item === 'object') clean[key] = sanitizeReplay(item, layout)
    }
  }
  if (clean.type === 4 && clean.data && typeof clean.data === 'object') {
    ;(clean.data as Record<string, unknown>).href = 'about:blank'
  }
  return clean
}
