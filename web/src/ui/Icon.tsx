import * as stylex from '@stylexjs/stylex'

// 图标取自 src/assets，黑色描边或填充换成 currentColor，颜色跟随文字。
const sources = import.meta.glob<string>('../assets/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const glyphs: Record<string, string> = {}
for (const [file, svg] of Object.entries(sources)) {
  const name = file.slice(file.lastIndexOf('/') + 1, -'.svg'.length)
  glyphs[name] = svg.replaceAll('"#000"', '"currentColor"').replace('<svg ', '<svg width="100%" height="100%" ')
}

export type IconName =
  | 'alert'
  | 'archive'
  | 'arrow-up'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'commit'
  | 'copy'
  | 'device'
  | 'dots'
  | 'external'
  | 'editor'
  | 'file'
  | 'folder'
  | 'inbox'
  | 'laptop'
  | 'lock'
  | 'memory'
  | 'message'
  | 'offline'
  | 'panel-right'
  | 'pause'
  | 'pen'
  | 'plus'
  | 'refresh'
  | 'reply'
  | 'settings'
  | 'shield'
  | 'sparkle'
  | 'stop'
  | 'tasks'
  | 'terminal'

export type BrandName = 'baton-mark' | 'baton-mark-dark' | 'baton-mark-mono'

const styles = stylex.create({
  root: { display: 'inline-flex', flexShrink: 0 },
  s12: { width: '12px', height: '12px' },
  s14: { width: '14px', height: '14px' },
  s15: { width: '15px', height: '15px' },
  s16: { width: '16px', height: '16px' },
  s24: { width: '24px', height: '24px' },
  s36: { width: '36px', height: '36px' },
})

const sizes = { 12: styles.s12, 14: styles.s14, 15: styles.s15, 16: styles.s16, 24: styles.s24, 36: styles.s36 }

export function Icon({
  name,
  size = 16,
  label,
  style,
}: {
  name: IconName | BrandName
  size?: keyof typeof sizes
  label?: string
  style?: stylex.StyleXStyles
}) {
  return (
    <span
      {...stylex.props(styles.root, sizes[size], style)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: glyphs[name] ?? '' }}
    />
  )
}

export function hasIcon(name: string) {
  return name in glyphs
}
