import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from 'react'

// 离底部不超过这个距离，就算停在最新内容上。
const liveEdgeThreshold = 32

// 聊天时间线的滚动：停在底部时跟随新内容，离开后显示回到最新内容，切换对话时回到底部。
// resetKey 是当前对话，ready 在时间线渲染出来后变化。onFollow 收到自动滚动后的位置，需要保持引用稳定。
export function useChatScroll(
  viewportRef: RefObject<HTMLElement | null>,
  { resetKey, ready, onFollow }: { resetKey: string; ready: boolean; onFollow?: (scrollTop: number) => void },
) {
  const atLiveEdge = useRef(true)
  const previousKey = useRef(resetKey)
  const [awayFromLatest, setAwayFromLatest] = useState(false)

  const scrollToEnd = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    onFollow?.(viewport.scrollTop)
  }, [viewportRef, onFollow])

  // 页面在新内容出现时调用。
  const followLatest = useCallback(() => {
    if (previousKey.current !== resetKey) {
      previousKey.current = resetKey
      atLiveEdge.current = true
      setAwayFromLatest(false)
    }
    if (atLiveEdge.current) scrollToEnd()
  }, [resetKey, scrollToEnd])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = viewport?.firstElementChild
    if (!viewport || !content) return
    const follow = () => {
      if (atLiveEdge.current) scrollToEnd()
    }
    const observer = new ResizeObserver(follow)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [viewportRef, resetKey, ready, scrollToEnd])

  useEffect(() => followLatest(), [followLatest])

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const viewport = event.currentTarget
    atLiveEdge.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= liveEdgeThreshold
    setAwayFromLatest(!atLiveEdge.current)
  }, [])

  const scrollToLatest = useCallback(() => {
    atLiveEdge.current = true
    scrollToEnd()
    setAwayFromLatest(false)
  }, [scrollToEnd])

  return { awayFromLatest, followLatest, onScroll, scrollToLatest }
}
