import * as stylex from '@stylexjs/stylex'
import {
  Archive,
  ArrowBendUpLeft,
  ArrowClockwise,
  ArrowSquareOut,
  ArrowUp,
  BookmarkSimple,
  Brain,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircle,
  ChatDots,
  Check,
  Clock,
  Code,
  Coins,
  Copy,
  DotsThree,
  File,
  Folder,
  Folders,
  GearSix,
  GitCommit,
  Globe,
  Laptop,
  ListBullets,
  ListChecks,
  Lock,
  MagnifyingGlass,
  Monitor,
  Pause,
  PencilSimple,
  Plus,
  Robot,
  ShieldCheck,
  SidebarSimple,
  Sparkle,
  Stop,
  TerminalWindow,
  Tray,
  Warning,
  WifiSlash,
  Wrench,
  X,
} from '@phosphor-icons/react'
import batonMark from '../assets/baton-mark.svg?raw'
import batonMarkDark from '../assets/baton-mark-dark.svg?raw'
import batonMarkMono from '../assets/baton-mark-mono.svg?raw'

const icons = {
  alert: Warning,
  archive: Archive,
  'arrow-up': ArrowUp,
  check: Check,
  'chevron-down': CaretDown,
  'chevron-left': CaretLeft,
  'chevron-right': CaretRight,
  clock: Clock,
  close: X,
  commit: GitCommit,
  copy: Copy,
  device: Monitor,
  details: ListBullets,
  dots: DotsThree,
  external: ArrowSquareOut,
  editor: Code,
  file: File,
  folder: Folder,
  inbox: Tray,
  laptop: Laptop,
  lock: Lock,
  memory: BookmarkSimple,
  message: ChatCircle,
  offline: WifiSlash,
  'panel-right': SidebarSimple,
  sidebar: SidebarSimple,
  pause: Pause,
  pen: PencilSimple,
  plus: Plus,
  refresh: ArrowClockwise,
  reply: ArrowBendUpLeft,
  settings: GearSix,
  shield: ShieldCheck,
  sparkle: Sparkle,
  stop: Stop,
  tasks: ListChecks,
  terminal: TerminalWindow,
  threads: ChatDots,
  projects: Folders,
  tool: Wrench,
  reasoning: Brain,
  'file-search': MagnifyingGlass,
  'web-search': Globe,
  subagent: Robot,
  usage: Coins,
} as const

const brands = {
  'baton-mark': batonMark,
  'baton-mark-dark': batonMarkDark,
  'baton-mark-mono': batonMarkMono,
}

export type IconName = keyof typeof icons
export type BrandName = keyof typeof brands

const styles = stylex.create({
  root: { display: 'inline-flex', flexShrink: 0 },
  s12: { width: '12px', height: '12px' },
  s14: { width: '14px', height: '14px' },
  s15: { width: '15px', height: '15px' },
  s16: { width: '16px', height: '16px' },
  s18: { width: '18px', height: '18px' },
  s24: { width: '24px', height: '24px' },
  s36: { width: '36px', height: '36px' },
})

const sizes = {
  12: styles.s12,
  14: styles.s14,
  15: styles.s15,
  16: styles.s16,
  18: styles.s18,
  24: styles.s24,
  36: styles.s36,
}

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
  const props = {
    ...stylex.props(styles.root, sizes[size], style),
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
  }
  if (name in brands) {
    const svg = brands[name as BrandName]
      .replaceAll('"#000"', '"currentColor"')
      .replace('<svg ', '<svg width="100%" height="100%" ')
    return <span {...props} dangerouslySetInnerHTML={{ __html: svg }} />
  }
  const Glyph = icons[name as IconName]
  return (
    <span {...props}>
      <Glyph size="100%" weight="regular" />
    </span>
  )
}
