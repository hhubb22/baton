// 从 design/tokens 生成 src/theme/tokens.stylex.ts 和 src/theme/themes.ts。设计稿是唯一来源，生成结果提交到仓库。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const designDir = fileURLToPath(new URL('../../design/tokens/', import.meta.url))
const themeDir = fileURLToPath(new URL('../src/theme/', import.meta.url))
const header = '// 由 scripts/tokens.mjs 从 design/tokens 生成，不要手改。修改设计稿后运行 `pnpm --dir web tokens`。'

const keywordColors = { white: '#fff', black: '#000', transparent: 'transparent' }

// 读取 `export name = tokens { key: value, ... }` 块，忽略注释。
function readGroups(file) {
  const source = readFileSync(designDir + file, 'utf8').replace(/\/\/.*$/gm, '')
  const groups = {}
  for (const match of source.matchAll(/export\s+(\w+)\s*=\s*tokens(?:\s*:\s*[\w.]+)?\s*\{([^}]*)\}/g)) {
    const entries = {}
    for (const line of match[2].matchAll(/(\w+)\s*:\s*(\w*\([^)]*\)|[^,\n]+)/g)) {
      entries[line[1]] = line[2].trim()
    }
    groups[match[1]] = entries
  }
  return groups
}

function color(value) {
  if (value.startsWith('.')) {
    const keyword = keywordColors[value.slice(1)]
    if (!keyword) throw new Error(`未知颜色关键字：${value}`)
    return keyword
  }
  const rgb = value.match(/^rgb\(([^)]*)\)$/)
  if (!rgb) throw new Error(`无法识别的颜色：${value}`)
  const parts = rgb[1].split(',').map((part) => part.trim())
  if (parts.length === 4) return `rgb(${parts.slice(0, 3).join(' ')} / ${parts[3]})`
  return `rgb(${parts.join(' ')})`
}

function length(value) {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`无法识别的长度：${value}`)
  return `${value}px`
}

const light = readGroups('colors.elyx')
const dark = readGroups('colors@dark.elyx')
const spacing = readGroups('spacing.elyx')

const lines = [
  header,
  "import * as stylex from '@stylexjs/stylex'",
  '',
  '// 主题默认跟随系统；用户手动选择时由 themes.ts 覆盖。',
  'export const colors = stylex.defineVars({',
]
const darkMedia = '@media (prefers-color-scheme: dark)'
for (const [key, value] of Object.entries(light.colors)) {
  const darkValue = dark.colors?.[key]
  if (darkValue && darkValue !== value) {
    lines.push(`  ${key}: { default: '${color(value)}', '${darkMedia}': '${color(darkValue)}' },`)
  } else {
    lines.push(`  ${key}: '${color(value)}',`)
  }
}
lines.push('})', '')

lines.push('// Project 头像底色，按创建顺序轮换。', 'export const hues = stylex.defineConsts({')
for (const [key, value] of Object.entries(light.hues)) lines.push(`  ${key}: '${color(value)}',`)
lines.push('})', '')

for (const group of ['space', 'radius', 'size']) {
  lines.push(`export const ${group} = stylex.defineConsts({`)
  for (const [key, value] of Object.entries(spacing[group])) lines.push(`  ${key}: '${length(value)}',`)
  lines.push('})', '')
}

const themes = [header, "import * as stylex from '@stylexjs/stylex'", "import { colors } from './tokens.stylex'", '']
for (const [name, source] of [['light', {}], ['dark', dark.colors]]) {
  themes.push(`export const ${name}Theme = stylex.createTheme(colors, {`)
  for (const [key, value] of Object.entries(light.colors)) themes.push(`  ${key}: '${color(source[key] ?? value)}',`)
  themes.push('})', '')
}

writeFileSync(themeDir + 'tokens.stylex.ts', lines.join('\n'))
writeFileSync(themeDir + 'themes.ts', themes.join('\n'))
console.log('已生成 src/theme/tokens.stylex.ts 和 src/theme/themes.ts')
