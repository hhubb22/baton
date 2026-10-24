import type { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { Schema } from 'effect'
import type { ProjectRuntimeResult } from '@baton/protocol'
import { MAX_FRAME } from './types.ts'

const Frame = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  request: Schema.Record(Schema.String, Schema.Json),
})
export async function serveRuntime(
  input: Readable,
  output: Writable,
  request: (value: (typeof Frame.Type)['request']) => Promise<ProjectRuntimeResult>,
  signal: AbortSignal,
) {
  let pending = Buffer.alloc(0)
  const active = new Map<number, Promise<void>>()
  let writer = Promise.resolve()
  const abort = () => {
    input.destroy()
    output.destroy()
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    for await (const chunk of input) {
      const data = Buffer.concat([pending, Buffer.from(chunk)])
      let start = 0
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        if (end - start > MAX_FRAME) throw new Error('Runtime 帧超限')
        const frame = Schema.decodeUnknownSync(Frame)(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end))),
        )
        if (active.size >= 8 || active.has(frame.id)) throw new Error('Runtime 在途请求超限或编号重复')
        const task = request(frame.request)
          .then((result) => {
            writer = writer.then(async () => {
              const line = JSON.stringify({ id: frame.id, result })
              if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('Runtime 响应超限')
              if (!output.write(line + '\n')) await once(output, 'drain', { signal })
            })
            return writer
          })
          .finally(() => active.delete(frame.id))
        active.set(frame.id, task)
        void task.catch(abort)
        start = end + 1
      }
      pending = data.subarray(start)
      if (pending.length > MAX_FRAME) throw new Error('Runtime 帧超限')
    }
    if (pending.length) throw new Error('Runtime 帧不完整')
  } finally {
    signal.removeEventListener('abort', abort)
    await Promise.allSettled(active.values())
  }
}
