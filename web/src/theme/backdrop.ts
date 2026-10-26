import dayFrost from '../../../design/resources/assets/backdrop-day-frost.jpg'
import day from '../../../design/resources/assets/backdrop-day.jpg'
import nightFrost from '../../../design/resources/assets/backdrop-night-frost.jpg'
import night from '../../../design/resources/assets/backdrop-night.jpg'
import { colors } from './tokens.stylex'

// 背景图沿用设计稿：scene 只在登录页露出，frost 是预先模糊的同一张图，铺在玻璃层下面。
const images = {
  light: { scene: day, frost: dayFrost },
  dark: { scene: night, frost: nightFrost },
}

export function sceneImage(theme: 'light' | 'dark') {
  return `url(${images[theme].scene})`
}

// 玻璃层：frost 图上叠一层半透明 glass 颜色。
export function glassImage(theme: 'light' | 'dark') {
  return `linear-gradient(${colors.glass}, ${colors.glass}), url(${images[theme].frost})`
}
