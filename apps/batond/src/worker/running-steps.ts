import type { ThreadTraceStep, ThreadTurnItem } from '@baton/protocol'
import { itemId, shortenLongest } from './items.ts'
import { displayText } from './reports.ts'

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const budget = 64 * 1024
const longestString = (value: unknown): number => {
  if (typeof value === 'string') return value.length ? bytes(value) : 0
  if (Array.isArray(value)) return value.reduce((longest, item) => Math.max(longest, longestString(item)), 0)
  if (value !== null && typeof value === 'object')
    return Object.values(value).reduce<number>((longest, item) => Math.max(longest, longestString(item)), 0)
  return 0
}

export function runningSteps(items: readonly ThreadTurnItem[]): {
  steps: readonly ThreadTraceStep[]
  truncated: boolean
} {
  const steps: ThreadTraceStep[] = items.map((item) => ({
    item_id: itemId(item.id),
    type: displayText(item.type),
    status: displayText(item.status),
    ordinal: item.ordinal,
    ...(item.parent_id === undefined ? {} : { parent_id: itemId(item.parent_id) }),
    ...(item.title === undefined ? {} : { title: displayText(item.title) }),
    ...(item.started_at === undefined ? {} : { started_at: item.started_at }),
    ...(item.completed_at === undefined ? {} : { completed_at: item.completed_at }),
    data: item.data,
    truncated: false,
    original_bytes: bytes(item.data),
  }))
  return boundRunningSteps(steps)
}

export function boundRunningSteps(
  items: readonly ThreadTraceStep[],
  alreadyTruncated = false,
): {
  steps: ThreadTraceStep[]
  truncated: boolean
} {
  const ordered = [...items].sort((a, b) => a.ordinal - b.ordinal)
  let truncated = alreadyTruncated || ordered.length > 32
  const steps = ordered.slice(-32)
  let reductions = 0
  while (bytes({ running_steps: steps, running_steps_truncated: true }) > budget && steps.length) {
    truncated = true
    let index = 0
    const size = (step: ThreadTraceStep) => Math.max(longestString(step.title), longestString(step.data))
    for (let i = 1; i < steps.length; i++) if (size(steps[i]!) > size(steps[index]!)) index = i
    const step = steps[index]!
    if (reductions++ >= 256) {
      steps.shift()
      continue
    }
    const title = step.title ?? ''
    const shortenTitle = longestString(title) > longestString(step.data)
    const shortened = shortenLongest(shortenTitle ? title : step.data)
    const next = shortenTitle
      ? { ...step, title: typeof shortened === 'string' ? shortened : '', truncated: true }
      : { ...step, data: shortened, truncated: true }
    if (bytes(next) >= bytes(step)) {
      steps.shift()
      continue
    }
    steps[index] = next
  }
  return { steps, truncated }
}
