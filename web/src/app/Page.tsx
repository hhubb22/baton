import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState, type ReactNode, type UIEventHandler } from 'react'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { DesktopTargetNotice } from './DesktopWorkspace'

// 主内容和 Thread 详情面板共用的圆角细边框。
export const pane = stylex.create({
  card: {
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
  },
})

const styles = stylex.create({
  page: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    height: '100%',
    backgroundColor: colors.canvas,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    flexShrink: 0,
    height: size.header,
    paddingInline: '20px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  title: { flexShrink: 1, minWidth: 0 },
  spacer: { flexGrow: 1 },
  body: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  sizedBody: { containerType: 'size' },
  scrollEnd: { height: '1px' },
  bottomFade: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '48px',
    pointerEvents: 'none',
    backgroundImage: `linear-gradient(to bottom, transparent, ${colors.canvas})`,
    opacity: 0,
    transition: 'opacity 160ms ease',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  bottomFadeVisible: { opacity: 1 },
  notice: { paddingBlock: space.md, paddingInline: space.xl, ':empty': { display: 'none' } },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    width: '100%',
    maxWidth: size.measure,
    marginInline: 'auto',
    paddingBlock: space.xl,
    paddingInline: space.xl,
  },
})

// 工作区里的主内容卡片：标题和状态在左，动作靠右，下面是可滚动的内容。
export function Page({
  title,
  status,
  actions,
  children,
  embedded = false,
  sizedBody = false,
  bottomFade = false,
  onBodyScroll,
  onBodyScrollEnd,
}: {
  title: ReactNode
  status?: ReactNode
  actions?: ReactNode
  children: ReactNode
  embedded?: boolean
  sizedBody?: boolean
  bottomFade?: boolean
  onBodyScroll?: UIEventHandler<HTMLDivElement>
  onBodyScrollEnd?: (body: HTMLDivElement) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !onBodyScrollEnd) return
    const onEnd = () => onBodyScrollEnd(body)
    body.addEventListener('scrollend', onEnd)
    return () => body.removeEventListener('scrollend', onEnd)
  }, [onBodyScrollEnd])
  useEffect(() => {
    const body = bodyRef.current
    if (!bottomFade || !body) return
    const update = () => setCanScrollDown(body.scrollHeight - body.clientHeight - body.scrollTop > 1)
    update()
    body.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(body)
    for (const child of body.children) observer?.observe(child)
    const intersection =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => setCanScrollDown(!entry.isIntersecting), { root: body })
    if (endRef.current) intersection?.observe(endRef.current)
    return () => {
      body.removeEventListener('scroll', update)
      observer?.disconnect()
      intersection?.disconnect()
    }
  }, [bottomFade])
  return (
    <section {...stylex.props(styles.page, !embedded && pane.card)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(text.bodyMedium, styles.title, text.truncate)}>{title}</h1>
        {status}
        <span {...stylex.props(styles.spacer)} />
        {actions}
      </header>
      <div ref={bodyRef} onScroll={onBodyScroll} {...stylex.props(styles.body, sizedBody && styles.sizedBody)}>
        <div {...stylex.props(styles.notice)}>
          <DesktopTargetNotice />
        </div>
        {children}
        {bottomFade && <div ref={endRef} aria-hidden="true" {...stylex.props(styles.scrollEnd)} />}
      </div>
      {bottomFade && (
        <div aria-hidden="true" {...stylex.props(styles.bottomFade, canScrollDown && styles.bottomFadeVisible)} />
      )}
    </section>
  )
}

// 内容列最宽 720px，与主对话同宽。
export function Column({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.column)}>{children}</div>
}
