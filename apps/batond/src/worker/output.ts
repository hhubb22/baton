import { randomUUID } from 'node:crypto'
import { Effect, Queue, Stream } from 'effect'
import type { AgentEventIdentity, AgentOutput } from './agent.ts'
import { displayText } from './reports.ts'

export const outputCapacity = 256 * 1024
export const outputPageBytes = 16 * 1024

/** Byte offsets refer to UTF-8 text in this process and turn only. */
export class OutputBuffer {
  private readonly bytes = Buffer.alloc(outputCapacity)
  private epoch = randomUUID()
  private base = 0
  private end = 0

  reset() {
    this.epoch = randomUUID()
    this.base = this.end = 0
  }

  append(text: string, gap = false) {
    if (gap) {
      // Reserve a missing byte so even a reader caught up to the old end sees the gap.
      this.base = this.end = this.end + 1
    }
    const source = Buffer.from(displayText(text), 'utf8')
    const end = this.end + source.length
    let skip = Math.max(0, source.length - outputCapacity)
    while (skip < source.length && (source[skip]! & 0xc0) === 0x80) skip++
    const start = this.end + skip
    const retained = source.subarray(skip)
    const position = start % outputCapacity
    const first = Math.min(retained.length, outputCapacity - position)
    retained.copy(this.bytes, position, 0, first)
    retained.copy(this.bytes, 0, first)
    this.end = end
    this.base = Math.max(this.base, end - outputCapacity, skip > 0 ? start : 0)
    while (this.base < this.end && (this.bytes[this.base % outputCapacity]! & 0xc0) === 0x80) this.base++
  }

  read(
    cursor?: string,
  ):
    | { readonly ok: false; readonly code: 'invalid_cursor'; readonly gap: false }
    | { readonly ok: true; readonly text: string; readonly cursor: string; readonly gap: boolean } {
    let offset = this.base
    let gap = this.base > 0
    if (cursor !== undefined && cursor !== '') {
      const match = /^([A-Za-z0-9-]+):(0|[1-9][0-9]*)$/.exec(cursor)
      if (!match || !Number.isSafeInteger(Number(match[2]))) return { ok: false, code: 'invalid_cursor', gap: false }
      const requested = Number(match[2])
      if (match[1] === this.epoch && requested >= this.base && requested <= this.end) {
        offset = requested
        gap = false
      } else gap = true
    }
    if (offset < this.end && (this.bytes[offset % outputCapacity]! & 0xc0) === 0x80)
      return { ok: false, code: 'invalid_cursor', gap: false }
    let end = Math.min(this.end, offset + outputPageBytes)
    while (end < this.end && (this.bytes[end % outputCapacity]! & 0xc0) === 0x80) end--
    const length = end - offset
    const result = Buffer.allocUnsafe(length)
    const first = Math.min(length, outputCapacity - (offset % outputCapacity))
    this.bytes.copy(result, 0, offset % outputCapacity, (offset % outputCapacity) + first)
    this.bytes.copy(result, first, 0, length - first)
    return { ok: true, text: result.toString('utf8'), cursor: `${this.epoch}:${end}`, gap }
  }
}

/** One wake-up and one byte buffer, independent of the number of incoming deltas. */
export const makeOutputMailbox = () => {
  const wake = Effect.runSync(Queue.dropping<void>(1))
  const buffer = new OutputBuffer()
  let identity: AgentEventIdentity | undefined
  let replyId: string | undefined
  let cursor: string | undefined
  let running: Pick<AgentOutput, 'runningSteps' | 'runningStepsTruncated'> | undefined
  let runningChanged = false
  const offer = (event: AgentOutput) => {
    if (
      !identity ||
      event.nativeSessionId !== identity.nativeSessionId ||
      event.messageId !== identity.messageId ||
      event.executionId !== identity.executionId
    ) {
      buffer.reset()
      cursor = undefined
      replyId = event.replyId
      running = undefined
      runningChanged = false
      identity = {
        nativeSessionId: event.nativeSessionId,
        messageId: event.messageId,
        executionId: event.executionId,
      }
    }
    if (event.runningSteps !== undefined) {
      running = { runningSteps: event.runningSteps, runningStepsTruncated: event.runningStepsTruncated ?? false }
      runningChanged = true
    } else {
      if (event.replyId !== replyId) {
        buffer.reset()
        cursor = undefined
        replyId = event.replyId
      }
      buffer.append(event.text, event.gap)
    }
    Queue.offerUnsafe(wake, undefined)
  }
  const stream = Stream.fromQueue(wake).pipe(
    Stream.mapEffect(() =>
      Effect.sync((): AgentOutput => {
        const page = buffer.read(cursor)
        if (!page.ok || !identity) throw new Error('Invalid internal output cursor')
        cursor = page.cursor
        const next = buffer.read(cursor)
        if (next.ok && next.text.length > 0) Queue.offerUnsafe(wake, undefined)
        const snapshot = runningChanged ? running : undefined
        runningChanged = false
        return {
          ...identity,
          text: page.text,
          gap: page.gap,
          ...(replyId === undefined ? {} : { replyId }),
          ...snapshot,
        }
      }),
    ),
  )
  return { offer, stream }
}
