import * as stylex from '@stylexjs/stylex'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { fonts } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'
import { MessageCodeBlock, MessageStreamingContext } from './MessageCodeBlock'
import { markdownComponents, safeLinkUrl } from './RestrictedMarkdown'
import './message-body.css'

const StreamingMarkdown = lazy(() => import('@lobehub/streamdown').then(({ Streamdown }) => ({ default: Streamdown })))
const remarkPlugins: NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']> = [
  remarkGfm,
  remarkCjkFriendly,
  [remarkMath, { singleDollarTextMath: false }],
]
const rehypePlugins = [rehypeKatex]
const remend = { htmlTags: false }

const styles = stylex.create({
  body: { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' },
  code: {
    fontFamily: fonts.mono,
    fontSize: '0.92em',
    paddingInline: space.xxs,
    borderRadius: radius.sm,
    backgroundColor: semantic.secondary,
  },
  path: {
    fontFamily: fonts.mono,
    fontSize: '0.92em',
    paddingInline: space.xxs,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: semantic.secondary, ':hover': semantic.muted },
    color: semantic.brandForeground,
    cursor: 'pointer',
  },
})

const isPath = (value: string) => /^(\/|~\/|[A-Za-z]:\\)/.test(value)
const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
function prefersReducedMotion() {
  return window.matchMedia?.(reducedMotionQuery).matches ?? false
}

export function MessageBody({
  body,
  onOpenPath,
  streaming = false,
  keepLineBreaks = false,
}: {
  body: string
  onOpenPath: (path: string) => void
  streaming?: boolean
  // 人写的消息保留单个换行，Markdown 默认会把它合并成空格。
  keepLineBreaks?: boolean
}) {
  const [active, setActive] = useState(streaming)
  const [selectedText, setSelectedText] = useState<string | null>(null)
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false)
  const root = useRef<HTMLDivElement>(null)
  const latestBody = useRef(body)
  const openPath = useRef(onOpenPath)
  useEffect(() => {
    openPath.current = onOpenPath
  }, [onOpenPath])
  useEffect(() => {
    latestBody.current = body
  }, [body])
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection()
      const node = root.current
      const inside =
        !!node &&
        !!selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        (node.contains(selection.anchorNode) || node.contains(selection.focusNode))
      setSelectedText((previous) => (inside ? (previous ?? latestBody.current) : null))
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [])
  if (streaming && !active) setActive(true)
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      p: ({ children }) => <p>{children}</p>,
      pre: ({ children }) => <MessageCodeBlock>{children}</MessageCodeBlock>,
      code: ({ children, className }) => {
        if (className) return <code className={className}>{children}</code>
        if (typeof children === 'string' && isPath(children)) {
          return (
            <button
              type="button"
              onClick={() => openPath.current(children)}
              {...stylex.props(styles.path, focusRing.ring)}
            >
              {children}
            </button>
          )
        }
        return <code {...stylex.props(styles.code)}>{children}</code>
      },
      img: () => null,
    }),
    [],
  )
  const visibleBody = selectedText ?? body
  const staticContent = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      skipHtml
      urlTransform={safeLinkUrl}
      components={components}
    >
      {visibleBody}
    </ReactMarkdown>
  )
  return (
    <div
      ref={root}
      className={`message-body ${keepLineBreaks ? 'message-body-line-breaks ' : ''}${stylex.props(styles.body).className ?? ''}`}
    >
      <MessageStreamingContext value={streaming}>
        {active && !reducedMotion ? (
          <Suspense fallback={staticContent}>
            <StreamingMarkdown
              animateOnMount={false}
              content={visibleBody}
              latexGuard
              remend={remend}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              skipHtml
              urlTransform={safeLinkUrl}
              components={components}
            />
          </Suspense>
        ) : (
          staticContent
        )}
      </MessageStreamingContext>
    </div>
  )
}
