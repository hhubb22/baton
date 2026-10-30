import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import {
  colorProperty,
  defaultInputs,
  generateColors,
  generateTheme,
  highContrastInputs,
  type Scheme,
  type SemanticColor,
} from './generate'

const css = readFileSync(join(import.meta.dirname, 'colors.css'), 'utf8')

type Rgba = { r: number; g: number; b: number; a: number }

// OKLCH 转线性 sRGB，公式来自 Björn Ottosson 的 OKLab 定义。
function parse(value: string): Rgba {
  const match = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value)
  if (!match) throw new Error(`不是 oklch 颜色：${value}`)
  const [l, c, h] = [Number(match[1]), Number(match[2]), (Number(match[3]) * Math.PI) / 180]
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const lm = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sm = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (channel: number) => Math.min(1, Math.max(0, channel))
  return {
    r: clamp(4.0767416621 * lm - 3.3077115913 * mm + 0.2309699292 * sm),
    g: clamp(-1.2684380046 * lm + 2.6097574011 * mm - 0.3413193965 * sm),
    b: clamp(-0.0041960863 * lm - 0.7034186147 * mm + 1.707614701 * sm),
    a: match[4] === undefined ? 1 : Number(match[4]),
  }
}

const over = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
})

const luminance = ({ r, g, b }: Rgba) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function ratio(foreground: string, background: string) {
  const back = parse(background)
  const [high, low] = [luminance(over(parse(foreground), back)), luminance(back)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

describe('语义颜色', () => {
  it('colors.css 与生成器的默认输入一致', () => {
    const theme = generateTheme(defaultInputs)
    for (const name of Object.keys(theme) as SemanticColor[]) {
      expect(css).toContain(`${colorProperty(name)}: ${theme[name]};`)
    }
  })

  it.each<[Scheme]>([['light'], ['dark']])('%s 主题的文字在各层背景上都读得清', (scheme) => {
    const palette = generateColors(defaultInputs, scheme)
    for (const background of [palette.background, palette.card, palette.popover, palette.sidebar]) {
      expect(ratio(palette.foreground, background)).toBeGreaterThanOrEqual(7)
      expect(ratio(palette.mutedForeground, background)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(palette.faintForeground, background)).toBeGreaterThanOrEqual(3.5)
    }
    expect(ratio(palette.primaryForeground, palette.primary)).toBeGreaterThanOrEqual(7)
    expect(ratio(palette.brandForeground, palette.brandSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.destructiveForeground, palette.destructiveSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.warningForeground, palette.warningSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.agentForeground, palette.agentSoft)).toBeGreaterThanOrEqual(4.5)
  })

  it.each<[Scheme]>([['light'], ['dark']])('%s 主题提高 contrast 后文字和边框都更明显', (scheme) => {
    const normal = generateColors(defaultInputs, scheme)
    const high = generateColors(highContrastInputs, scheme)
    expect(ratio(high.mutedForeground, high.background)).toBeGreaterThan(
      ratio(normal.mutedForeground, normal.background),
    )
    expect(ratio(high.border, high.background)).toBeGreaterThan(ratio(normal.border, normal.background))
  })
})
