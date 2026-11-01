import * as stylex from '@stylexjs/stylex'
import { semantic } from './semantic.stylex'
import { motion } from './tokens.stylex'

const fadeIn = stylex.keyframes({ from: { opacity: 0 } })
const riseIn = stylex.keyframes({ from: { opacity: 0, transform: 'translateY(6px)' } })
const popIn = stylex.keyframes({ from: { opacity: 0, transform: 'scale(0.6)' } })

// 挂载时播放一次的进场。列表首屏不要用，新出现的内容才用，见 ui/motion.tsx。
export const enter = stylex.create({
  fade: {
    animationName: fadeIn,
    animationDuration: motion.popover,
    animationTimingFunction: motion.easeOut,
    animationFillMode: 'backwards',
  },
  // 新消息、横幅这类占一整行的内容，只上移 6px。
  rise: {
    animationName: riseIn,
    animationDuration: motion.popover,
    animationTimingFunction: motion.easeOut,
    animationFillMode: 'backwards',
  },
  // 活动记录里新出现的步骤：比消息慢，后台进展不需要抢注意力。
  settle: {
    animationName: riseIn,
    animationDuration: motion.activity,
    animationTimingFunction: motion.easeOut,
    animationFillMode: 'backwards',
  },
  // 16px 以内的小符号：对勾、未读点、状态图标。
  pop: {
    animationName: popIn,
    animationDuration: motion.micro,
    animationTimingFunction: motion.easeOut,
    animationFillMode: 'backwards',
  },
})

const reducedMotion = '@media (prefers-reduced-motion: reduce)'
const sweep = stylex.keyframes({
  from: { backgroundPosition: '115% 0' },
  to: { backgroundPosition: '-15% 0' },
})
// 深色文字再加深几乎看不出，所以浅色模式的光带往背景色方向提亮，深色模式往前景色方向提亮。
const glint = `light-dark(color-mix(in oklab, ${semantic.mutedForeground} 25%, ${semantic.background}), ${semantic.foreground})`

// 循环动画只用在确实还在收到新事件的内容上，事件停了就要摘掉。
export const live = stylex.create({
  // 文字上走一道微光。系统减少动态效果时只留静止的文字。
  shimmer: {
    color: { default: 'transparent', [reducedMotion]: 'inherit' },
    backgroundImage: {
      default: `linear-gradient(90deg, ${semantic.mutedForeground} 32%, ${glint} 50%, ${semantic.mutedForeground} 68%)`,
      [reducedMotion]: 'none',
    },
    backgroundSize: '250% 100%',
    backgroundClip: 'text',
    animationName: { default: sweep, [reducedMotion]: 'none' },
    animationDuration: motion.shimmer,
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
})

export const leave = stylex.create({
  fade: {
    opacity: 0,
    pointerEvents: 'none',
    transitionProperty: 'opacity',
    transitionDuration: motion.exit,
    transitionTimingFunction: motion.easeOut,
  },
})
