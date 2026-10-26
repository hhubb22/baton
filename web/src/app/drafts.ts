import { useCallback, useSyncExternalStore } from 'react'
import type { ID } from '../data/types'

// 按 key 保存的草稿。存储对象本身不变，组件只订阅自己那一条，输入时不会让整个工作区重新渲染。
export interface DraftStore<T> {
  get: (key: ID) => T | undefined
  set: (key: ID, draft: T | null | ((current: T | undefined) => T | null)) => void
  subscribe: (key: ID, listener: () => void) => () => void
}

export function createDraftStore<T>(): DraftStore<T> {
  const drafts = new Map<ID, T>()
  const listeners = new Map<ID, Set<() => void>>()
  return {
    get: (key) => drafts.get(key),
    set(key, draft) {
      const value =
        typeof draft === 'function' ? (draft as (current: T | undefined) => T | null)(drafts.get(key)) : draft
      if (value === drafts.get(key)) return
      if (value) drafts.set(key, value)
      else drafts.delete(key)
      listeners.get(key)?.forEach((listener) => listener())
    },
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(key)
      }
    },
  }
}

export function useDraft<T>(store: DraftStore<T>, key: ID) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [store, key])
  return useSyncExternalStore(subscribe, () => store.get(key))
}
