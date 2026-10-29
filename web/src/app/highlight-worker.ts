import type { ThemedToken } from '@pierre/highlights'
import { highlightCode } from './highlight-code'

let worker: Worker | null | undefined
let nextId = 0
const pending = new Map<number, { resolve: (lines: ThemedToken[][] | null) => void; reject: () => void }>()
const cache = new Map<string, { lines: ThemedToken[][]; size: number }>()
let cacheSize = 0

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  if (typeof Worker === 'undefined') return (worker = null)
  try {
    worker = new Worker(new URL('./highlight-code.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; lines: ThemedToken[][] | null }>) => {
      const request = pending.get(event.data.id)
      pending.delete(event.data.id)
      request?.resolve(event.data.lines)
    }
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      for (const request of pending.values()) request.reject()
      pending.clear()
    }
  } catch {
    worker = null
  }
  return worker
}

export async function requestHighlight(content: string, path: string, theme: 'light' | 'dark', complete = true) {
  const key = complete && content.length <= 20_000 ? JSON.stringify([theme, path, content]) : null
  const cached = key ? cache.get(key) : undefined
  if (key && cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached.lines
  }
  const current = getWorker()
  let lines: ThemedToken[][] | null = null
  if (current) {
    try {
      lines = await new Promise<ThemedToken[][] | null>((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        try {
          current.postMessage({ id, content, path, theme })
        } catch {
          pending.delete(id)
          reject()
        }
      })
    } catch {
      // Worker 不可用时继续在主线程渲染。
      lines = await highlightCode(content, path, theme)
    }
  } else {
    lines = await highlightCode(content, path, theme)
  }
  if (key && lines) {
    const previous = cache.get(key)
    if (previous) cacheSize -= previous.size
    cache.delete(key)
    cache.set(key, { lines, size: content.length })
    cacheSize += content.length
    while (cache.size > 256 || cacheSize > 1_000_000) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cacheSize -= cache.get(oldest)!.size
      cache.delete(oldest)
    }
  }
  return lines
}
