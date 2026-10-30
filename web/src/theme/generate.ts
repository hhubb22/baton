// 由 base、accent、contrast 三个输入生成全部语义颜色，色阶在 OKLCH 中计算。
// colors.css 保存默认输入的结果，generate.test.ts 核对两边一致。

export type ThemeInputs = {
  baseHue: number
  baseChroma: number
  accentHue: number
  accentChroma: number
  // 0 到 1，只影响文字和边框与背景的距离。
  contrast: number
}

export const defaultInputs: ThemeInputs = {
  baseHue: 80,
  baseChroma: 0.006,
  accentHue: 262,
  accentChroma: 0.15,
  contrast: 0.5,
}

export const highContrastInputs: ThemeInputs = { ...defaultInputs, contrast: 1 }

export type Scheme = 'light' | 'dark'

const round = (value: number, digits = 3) => Number(value.toFixed(digits))

function color(lightness: number, chroma: number, hue: number, alpha?: number) {
  const channels = `${round(lightness)} ${round(chroma)} ${round(hue, 1)}`
  return alpha === undefined ? `oklch(${channels})` : `oklch(${channels} / ${round(alpha)})`
}

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount

const statusHues = { destructive: 27, warning: 58, success: 150, info: 240, agent: 185 }

export function generateColors(
  { baseHue, baseChroma, accentHue, accentChroma, contrast }: ThemeInputs,
  scheme: Scheme,
) {
  const neutral = (lightness: number, scale = 1) => color(lightness, baseChroma * scale, baseHue)
  const ink = (alpha: number) => (scheme === 'light' ? color(0.2, baseChroma, baseHue, alpha) : color(1, 0, 0, alpha))
  const brand = (lightness: number, scale = 1) => color(lightness, accentChroma * scale, accentHue)

  if (scheme === 'light') {
    return {
      background: neutral(0.985, 0.5),
      foreground: neutral(lerp(0.26, 0.16, contrast), 1.5),
      card: color(1, 0, 0),
      popover: color(1, 0, 0),
      sidebar: neutral(0.962),
      secondary: neutral(0.94),
      muted: ink(0.045),
      mutedForeground: neutral(lerp(0.52, 0.38, contrast)),
      faintForeground: neutral(lerp(0.6, 0.44, contrast)),
      accent: ink(0.08),
      border: ink(lerp(0.06, 0.14, contrast)),
      input: ink(lerp(0.1, 0.24, contrast)),
      ring: brand(0.55),
      primary: neutral(0.24, 1.5),
      primaryHover: neutral(0.32, 1.5),
      primaryForeground: neutral(0.985, 0.5),
      brand: brand(0.55),
      brandHover: brand(0.5),
      brandPressed: brand(0.46),
      brandSoft: brand(0.95, 0.17),
      brandForeground: brand(0.45, 0.93),
      brandOn: color(1, 0, 0),
      destructive: color(0.55, 0.19, statusHues.destructive),
      destructiveForeground: color(0.48, 0.17, statusHues.destructive),
      destructiveSoft: color(0.955, 0.02, statusHues.destructive),
      warning: color(0.68, 0.17, statusHues.warning),
      warningForeground: color(0.47, 0.12, statusHues.warning),
      warningSoft: color(0.96, 0.025, statusHues.warning),
      success: color(0.55, 0.13, statusHues.success),
      successForeground: color(0.43, 0.11, statusHues.success),
      successSoft: color(0.96, 0.03, statusHues.success),
      info: color(0.55, 0.13, statusHues.info),
      infoForeground: color(0.45, 0.12, statusHues.info),
      infoSoft: color(0.955, 0.02, statusHues.info),
      agent: color(0.62, 0.11, statusHues.agent),
      agentForeground: color(0.43, 0.08, statusHues.agent),
      agentSoft: color(0.96, 0.025, statusHues.agent),
      inverse: neutral(0.24, 1.5),
      onInverse: neutral(0.97, 0.5),
      onInverseMuted: neutral(0.75),
      code: neutral(0.965),
      overlay: color(0.15, 0, 0, 0.32),
      glass: color(1, 0, 0, 0.66),
      glassEdge: color(1, 0, 0, 0.55),
      shadowSoft: color(0.2, baseChroma, baseHue, 0.05),
      shadowNear: color(0.2, baseChroma, baseHue, 0.08),
      shadowFar: color(0.2, baseChroma, baseHue, 0.14),
      edgeHigh: color(1, 0, 0, 0),
      edgeLow: ink(0.04),
    }
  }
  return {
    background: neutral(0.175, 1.2),
    foreground: neutral(lerp(0.9, 0.98, contrast), 0.5),
    card: neutral(0.205, 1.2),
    popover: neutral(0.225, 1.2),
    sidebar: neutral(0.15, 1.2),
    secondary: neutral(0.26, 1.2),
    muted: ink(0.05),
    mutedForeground: neutral(lerp(0.72, 0.84, contrast)),
    faintForeground: neutral(lerp(0.62, 0.76, contrast)),
    accent: ink(0.09),
    border: ink(lerp(0.06, 0.14, contrast)),
    input: ink(lerp(0.1, 0.24, contrast)),
    ring: brand(0.66),
    primary: neutral(0.94, 0.5),
    primaryHover: neutral(0.86, 0.5),
    primaryForeground: neutral(0.2, 1.2),
    brand: brand(0.62),
    brandHover: brand(0.67),
    brandPressed: brand(0.57),
    brandSoft: brand(0.27, 0.33),
    brandForeground: brand(0.76, 0.73),
    brandOn: color(1, 0, 0),
    destructive: color(0.5, 0.17, statusHues.destructive),
    destructiveForeground: color(0.72, 0.15, statusHues.destructive),
    destructiveSoft: color(0.27, 0.05, statusHues.destructive),
    warning: color(0.72, 0.16, statusHues.warning),
    warningForeground: color(0.8, 0.11, statusHues.warning),
    warningSoft: color(0.27, 0.04, statusHues.warning),
    success: color(0.72, 0.15, statusHues.success),
    successForeground: color(0.78, 0.13, statusHues.success),
    successSoft: color(0.27, 0.04, statusHues.success),
    info: color(0.68, 0.12, statusHues.info),
    infoForeground: color(0.78, 0.1, statusHues.info),
    infoSoft: color(0.27, 0.04, statusHues.info),
    agent: color(0.73, 0.11, statusHues.agent),
    agentForeground: color(0.8, 0.09, statusHues.agent),
    agentSoft: color(0.28, 0.04, statusHues.agent),
    inverse: neutral(0.3, 1.2),
    onInverse: neutral(0.96, 0.5),
    onInverseMuted: neutral(0.75),
    code: neutral(0.15, 1.2),
    overlay: color(0.1, 0, 0, 0.6),
    glass: color(0.15, baseChroma, baseHue, 0.72),
    glassEdge: color(1, 0, 0, 0.09),
    shadowSoft: color(0.1, 0, 0, 0.2),
    shadowNear: color(0.1, 0, 0, 0.3),
    shadowFar: color(0.1, 0, 0, 0.45),
    edgeHigh: color(1, 0, 0, 0.06),
    edgeLow: color(1, 0, 0, 0),
  }
}

export type SemanticColor = keyof ReturnType<typeof generateColors>

export function colorProperty(name: SemanticColor) {
  return `--color-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

// 同一个 CSS 值里放两套颜色，由 color-scheme 决定显示哪一套。
export function generateTheme(inputs: ThemeInputs) {
  const light = generateColors(inputs, 'light')
  const dark = generateColors(inputs, 'dark')
  const entries = (Object.keys(light) as SemanticColor[]).map(
    (name) => [name, `light-dark(${light[name]}, ${dark[name]})`] as const,
  )
  return Object.fromEntries(entries) as Record<SemanticColor, string>
}
