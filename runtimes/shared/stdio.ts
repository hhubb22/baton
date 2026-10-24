import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export const MAX_FRAME = 192 * 1024

// 每帧一行，容量按 UTF-8 字节计算；背压由管道传播到发送方。
export async function* frames(input: Readable): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0)
  for await (const chunk of input) {
    const data = Buffer.concat([pending, Buffer.from(chunk)])
    let start = 0
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      if (end - start > MAX_FRAME) throw new Error('sidecar_frame_too_large')
      yield JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end)))
      start = end + 1
    }
    pending = data.subarray(start)
    if (pending.length > MAX_FRAME) throw new Error('sidecar_frame_too_large')
  }
  if (pending.length) throw new Error('sidecar_incomplete_frame')
}

export async function writeFrame(output: Writable, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > MAX_FRAME) throw new Error('sidecar_frame_too_large')
  if (!output.write(text + '\n')) await once(output, 'drain')
}

export class StdioClient {
  private next = 0
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private closed = false
  constructor(
    private input: Readable,
    private output: Writable,
  ) {
    void this.read()
  }
  private async read() {
    let error = new Error('sidecar_closed')
    try {
      for await (const value of frames(this.input)) {
        if (
          !value ||
          typeof value !== 'object' ||
          !Number.isSafeInteger((value as any).id) ||
          (value as any).id <= 0 ||
          !Object.hasOwn(value, 'result')
        )
          throw new Error('sidecar_invalid_response')
        const frame = value as { id: number; result: unknown }
        const waiter = this.pending.get(frame.id)
        if (!waiter) throw new Error('sidecar_unknown_response')
        clearTimeout(waiter.timer)
        this.pending.delete(frame.id)
        waiter.resolve(frame.result)
      }
    } catch (cause) {
      error = cause instanceof Error ? cause : error
    }
    this.closed = true
    this.input.destroy()
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
  async call(request: unknown): Promise<any> {
    if (this.closed) throw new Error('sidecar_closed')
    if (this.pending.size >= 8) throw new Error('sidecar_capacity')
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('sidecar_timeout'))
      }, 32_000)
      this.pending.set(id, { resolve, reject, timer })
      void writeFrame(this.output, { id, request }).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }
}
