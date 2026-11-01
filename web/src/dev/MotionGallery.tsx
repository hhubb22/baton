// 画廊的动效区：token 标本、可重放的模式，以及一段用真实组件演出的 Thread 过程。
import * as stylex from '@stylexjs/stylex'
import { useEffect, useState, type ReactNode } from 'react'
import { MessageActions } from '../app/MessageActions'
import { TraceDisclosure } from '../app/ReplyParts'
import type { TraceStep } from '../data/types'
import { enter, leave } from '../theme/motion'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, space } from '../theme/tokens.stylex'
import { UnreadDot } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Disclosure, DisclosureChevron, DisclosurePanel, DisclosureTrigger } from '../ui/Disclosure'
import { Appear, usePresence } from '../ui/motion'
import { Segmented, Tabs } from '../ui/Tabs'
import { ThreadStatusIcon, type ThreadStatus } from '../ui/ThreadStatusIcon'

const styles = stylex.create({
  tokens: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: space.sm },
  token: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.card,
  },
  tokenHead: { display: 'flex', justifyContent: 'space-between', gap: space.sm },
  faint: { color: semantic.faintForeground },
  muted: { color: semantic.mutedForeground },
  track: { position: 'relative', height: '8px', borderRadius: radius.pill, backgroundColor: semantic.secondary },
  puck: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '8px',
    height: '8px',
    borderRadius: radius.pill,
    backgroundColor: semantic.foreground,
    transitionProperty: 'left',
  },
  puckEnd: { left: 'calc(100% - 8px)' },
  patterns: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: space.sm },
  pattern: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    minHeight: '168px',
    padding: space.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.card,
  },
  stage: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.sm,
    flexGrow: 1,
  },
  bubble: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    paddingBlock: '6px',
    paddingInline: space.md,
    borderRadius: radius.lg,
    backgroundColor: semantic.secondary,
  },
  thread: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '300px',
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.background,
    boxShadow: shadow.panel,
  },
  threadHead: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: '48px',
    flexShrink: 0,
    paddingInline: space.lg,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: semantic.border,
  },
  threadTitle: { flexGrow: 1 },
  threadBody: { display: 'flex', flexDirection: 'column', gap: space.lg, flexGrow: 1, padding: space.xl, minHeight: 0 },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.xs,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: semantic.mutedForeground,
  },
  steps: { display: 'flex', flexDirection: 'column', gap: space.xs, paddingTop: space.sm, paddingLeft: space.lg },
  liveControls: { display: 'flex', gap: space.xs, marginTop: 'auto' },
  reply: { display: 'flex', flexDirection: 'column', gap: space.sm, maxWidth: '560px' },
  exitBody: { transition: `opacity ${motion.exit} ${motion.easeOut}` },
  exitHidden: { opacity: 0 },
})

const durations = [
  { name: 'micro', value: '120 ms', note: '按钮、开关、悬停', duration: motion.micro },
  { name: 'exit', value: '140 ms', note: '所有退场', duration: motion.exit },
  { name: 'popover', value: '180 ms', note: '弹层、折叠、消息进场', duration: motion.popover },
  { name: 'modal', value: '240 ms', note: '弹窗', duration: motion.modal },
  { name: 'layout', value: '260 ms', note: '面板宽度', duration: motion.layout },
  { name: 'activity', value: '420 ms', note: '活动记录里新出现的步骤', duration: motion.activity },
  { name: 'shimmer', value: '2800 ms', note: '进行中步骤的微光', duration: motion.shimmer },
]
const curves = [
  { name: 'easeOut', note: '进场和退场', ease: motion.easeOut },
  { name: 'easeInOut', note: '滑块这类屏幕内移动', ease: motion.easeInOut },
  { name: 'easeDrawer', note: '侧栏、面板展开收起', ease: motion.easeDrawer },
]

// 标本不断往返，并排看时长和曲线的差别。
function useRoundTrip(period = 1400) {
  const [end, setEnd] = useState(false)
  useEffect(() => {
    const timer = window.setInterval(() => setEnd((value) => !value), period)
    return () => window.clearInterval(timer)
  }, [period])
  return end
}

function Tokens() {
  const end = useRoundTrip()
  return (
    <div {...stylex.props(styles.tokens)}>
      {durations.map((item) => (
        <TokenCard key={item.name} name={item.name} value={item.value} note={item.note}>
          <span
            {...stylex.props(styles.puck, end && styles.puckEnd)}
            style={{ transitionDuration: item.duration, transitionTimingFunction: motion.easeOut }}
          />
        </TokenCard>
      ))}
      {curves.map((item) => (
        <TokenCard key={item.name} name={item.name} value="600 ms" note={item.note}>
          <span
            {...stylex.props(styles.puck, end && styles.puckEnd)}
            style={{ transitionDuration: '600ms', transitionTimingFunction: item.ease }}
          />
        </TokenCard>
      ))}
    </div>
  )
}

function TokenCard({
  name,
  value,
  note,
  children,
}: {
  name: string
  value: string
  note: string
  children: ReactNode
}) {
  return (
    <div {...stylex.props(styles.token)}>
      <div {...stylex.props(styles.tokenHead)}>
        <span {...stylex.props(text.mono)}>{name}</span>
        <span {...stylex.props(text.caption, styles.faint)}>{value}</span>
      </div>
      <div {...stylex.props(styles.track)}>{children}</div>
      <span {...stylex.props(text.caption, styles.muted)}>{note}</span>
    </div>
  )
}

function Pattern({ title, onReplay, children }: { title: string; onReplay?: () => void; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.pattern)}>
      <div {...stylex.props(styles.tokenHead)}>
        <span {...stylex.props(text.label13Medium)}>{title}</span>
        {onReplay && (
          <Button small variant="ghost" onClick={onReplay}>
            重放
          </Button>
        )}
      </div>
      <div {...stylex.props(styles.stage)}>{children}</div>
    </div>
  )
}

const liveCommands = ['cat gateway.ts', 'pnpm test', 'git diff gateway.ts', 'pnpm test', 'cat reconnect.log']

function liveStep(index: number): TraceStep {
  return {
    item_id: `live-${index}`,
    type: 'command_execution',
    status: 'running',
    ordinal: index,
    data: { input: liveCommands[index % liveCommands.length]! },
    truncated: false,
    original_bytes: 0,
  }
}

// 用按钮代替真实事件：「新事件」多一步，「静默 3 秒」把等待阈值缩短，看没有新事件时的样子。真实页面的阈值是 30 秒。
function LiveProgressPattern() {
  const [received, setReceived] = useState(2)
  const [open, setOpen] = useState(true)
  const [quietAfter, setQuietAfter] = useState<number | undefined>(undefined)
  return (
    <Pattern title="进行中 Live">
      <TraceDisclosure
        steps={Array.from({ length: received }, (_, index) => liveStep(index))}
        live
        open={open}
        onOpenChange={setOpen}
        threadId="gallery-live"
        device={undefined}
        quietAfterMs={quietAfter}
      />
      <div {...stylex.props(styles.liveControls)}>
        <Button
          small
          onClick={() => {
            setQuietAfter(undefined)
            setReceived((value) => value + 1)
          }}
        >
          新事件
        </Button>
        <Button small variant="ghost" onClick={() => setQuietAfter(3000)}>
          静默 3 秒
        </Button>
      </div>
    </Pattern>
  )
}

function Patterns() {
  const [messages, setMessages] = useState(0)
  const [banner, setBanner] = useState(0)
  const [view, setView] = useState<'thread' | 'files' | 'memory'>('thread')
  const [tab, setTab] = useState<'all' | 'open'>('all')
  const [unread, setUnread] = useState(false)
  const [status, setStatus] = useState<ThreadStatus>('idle')
  const [open, setOpen] = useState(true)
  const [visible, setVisible] = useState(true)
  const presence = usePresence(visible)
  return (
    <div {...stylex.props(styles.patterns)}>
      <LiveProgressPattern />
      <Pattern title="滑块 Segmented / Tabs">
        <Segmented
          label="视图"
          value={view}
          onChange={setView}
          options={[
            { value: 'thread', label: '对话' },
            { value: 'files', label: '文件' },
            { value: 'memory', label: '记忆' },
          ]}
        />
        <Tabs
          label="筛选"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: '全部', count: 24 },
            { value: 'open', label: '进行中', count: 3 },
          ]}
        />
      </Pattern>
      <Pattern title="新消息 Rise" onReplay={() => setMessages((value) => value + 1)}>
        <div key={messages} {...stylex.props(text.body, styles.bubble, enter.rise)}>
          把重连测试跑一遍
        </div>
      </Pattern>
      <Pattern title="横幅 Banner" onReplay={() => setBanner((value) => value + 1)}>
        <Banner key={banner} title="等待设备上线" detail="MacBook Pro 离线，恢复后继续。" />
      </Pattern>
      <Pattern title="符号切换 Swap">
        <Button
          small
          onClick={() =>
            setStatus((value) => (value === 'idle' ? 'running' : value === 'running' ? 'attention' : 'idle'))
          }
        >
          切换状态
        </Button>
        <ThreadStatusIcon status={status} label={status} />
        <MessageActions body="复制这段文字" />
      </Pattern>
      <Pattern title="未读点 Appear" onReplay={() => setUnread((value) => !value)}>
        <span {...stylex.props(text.small)}>修复断线重连</span>
        <Appear when={unread}>
          <UnreadDot />
        </Appear>
      </Pattern>
      <Pattern title="退场 Presence" onReplay={() => setVisible((value) => !value)}>
        {presence.mounted && (
          <div {...stylex.props(text.body, styles.bubble, enter.rise, presence.leaving && leave.fade)}>跳到最新</div>
        )}
      </Pattern>
      <Pattern title="折叠 Disclosure">
        <Disclosure open={open} onOpenChange={setOpen}>
          <DisclosureTrigger {...stylex.props(text.body, styles.trigger)}>
            <DisclosureChevron open={open} />
            执行过程 · 3 步
          </DisclosureTrigger>
          <DisclosurePanel>
            <div {...stylex.props(text.body, styles.steps, styles.muted)}>
              <span>读取 gateway.ts</span>
              <span>运行 pnpm test</span>
              <span>写入 gateway.ts</span>
            </div>
          </DisclosurePanel>
        </Disclosure>
      </Pattern>
    </div>
  )
}

type Beat = {
  at: number
  status: ThreadStatus
  sent: boolean
  steps: number
  open: boolean
  reply: number
  unread: boolean
  visible: boolean
}

const replyText = '重连后 outbox 会按序补发，48 个测试全部通过。'
const stepNames = ['读取 gateway.ts', '运行 pnpm test', '写入 gateway.ts']
const replyStart = 8200
const blank: Beat = { at: 0, status: 'idle', sent: false, steps: 0, open: true, reply: 0, unread: false, visible: true }

// 每一拍的状态都由上一拍引起；结尾整段淡出，再从原来的空闲画面开始。
const beats: Beat[] = [
  blank,
  { ...blank, at: 1200, sent: true },
  { ...blank, at: 2000, sent: true, status: 'running' },
  { ...blank, at: 2800, sent: true, status: 'running', steps: 1 },
  { ...blank, at: 4600, sent: true, status: 'running', steps: 2 },
  { ...blank, at: 6400, sent: true, status: 'running', steps: 3 },
  { ...blank, at: replyStart, sent: true, status: 'running', steps: 3, open: false, reply: 1 },
  {
    ...blank,
    at: replyStart + 2200,
    sent: true,
    status: 'idle',
    steps: 3,
    open: false,
    reply: replyText.length,
    unread: true,
  },
  {
    ...blank,
    at: replyStart + 5000,
    sent: true,
    status: 'idle',
    steps: 3,
    open: false,
    reply: replyText.length,
    unread: true,
    visible: false,
  },
]
const loopEnd = replyStart + 5400
// 系统减少动态效果时停在这一拍：结果已经完整地留在屏幕上。
const poster = beats[7]!

function useThreadStory() {
  const reduced =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (reduced) return
    const started = performance.now()
    const timer = window.setInterval(() => setElapsed((performance.now() - started) % loopEnd), 40)
    return () => window.clearInterval(timer)
  }, [reduced])
  if (reduced) return poster
  const beat = beats.findLast((item) => item.at <= elapsed) ?? blank
  // 回复按字符逐步写出，到下一拍时写完。
  if (beat.reply > 0 && beat.reply < replyText.length) {
    return { ...beat, reply: Math.ceil(((elapsed - replyStart) / 2200) * replyText.length) }
  }
  return beat
}

function ThreadStory() {
  const beat = useThreadStory()
  return (
    <div {...stylex.props(styles.thread)}>
      <div {...stylex.props(styles.threadHead)}>
        <ThreadStatusIcon status={beat.status} label={beat.status === 'running' ? '运行中' : '空闲'} />
        <span {...stylex.props(text.label13Medium, styles.threadTitle)}>修复断线重连</span>
        <Appear when={beat.unread}>
          <UnreadDot />
        </Appear>
      </div>
      <div {...stylex.props(styles.threadBody, styles.exitBody, !beat.visible && styles.exitHidden)}>
        {beat.sent && <div {...stylex.props(text.body, styles.bubble, enter.rise)}>把重连测试跑一遍，失败就修。</div>}
        {beat.steps > 0 && (
          <div {...stylex.props(enter.fade)}>
            <TraceDisclosure
              steps={stepNames.slice(0, beat.steps).map((title, index) => ({
                item_id: `story-${index}`,
                type: 'dynamic_tool',
                status: beat.status === 'running' && index === beat.steps - 1 ? 'running' : 'completed',
                ordinal: index,
                title,
                data: {},
                truncated: false,
                original_bytes: 0,
              }))}
              live={beat.status === 'running'}
              open={beat.open}
              onOpenChange={() => undefined}
              threadId="gallery-story"
              device={undefined}
            />
          </div>
        )}
        {beat.reply > 0 && <div {...stylex.props(text.body, styles.reply)}>{replyText.slice(0, beat.reply)}</div>}
      </div>
    </div>
  )
}

export function MotionGallery() {
  return (
    <>
      <ThreadStory />
      <Tokens />
      <Patterns />
    </>
  )
}
