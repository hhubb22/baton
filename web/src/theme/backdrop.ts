import * as stylex from '@stylexjs/stylex'
import day from '../../../design/resources/assets/backdrop-day.jpg'
import night from '../../../design/resources/assets/backdrop-night.jpg'
import { colors } from './tokens.stylex'

// 背景图沿用设计稿：浅色主题用日景，深色主题用夜景。
export function sceneImage(theme: 'light' | 'dark') {
  return `url(${theme === 'light' ? day : night})`
}

// 磨砂层：模糊下面的原图，再叠一层半透明 glass 颜色。
export const glass = stylex.create({
  layer: {
    backgroundColor: colors.glass,
    backdropFilter: 'blur(48px) saturate(140%)',
  },
})
