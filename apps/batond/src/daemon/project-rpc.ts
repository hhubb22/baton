import { randomUUID } from 'node:crypto'
import type { ProjectRuntimeRequest, ProjectRuntimeResult } from '@baton/protocol'

interface Pending {
  resolve: (result: ProjectRuntimeResult) => void
  reject: (error: Error) => void
}

/** Each authenticated WSS connection owns its pending requests and cancellation listeners. */
export class ProjectRPC {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  constructor(
    private readonly send: (request: ProjectRuntimeRequest, messageId: string) => Promise<void>,
    private readonly maximum = 64,
  ) {}

  readonly request = (request: ProjectRuntimeRequest, signal: AbortSignal): Promise<ProjectRuntimeResult> => {
    if (this.closed || signal.aborted) return Promise.reject(new Error('Project 控制连接已取消'))
    if (this.pending.size >= this.maximum) return Promise.reject(new Error('Project 控制请求已满'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        if (settled) return false
        settled = true
        this.pending.delete(id)
        signal.removeEventListener('abort', abort)
        clearTimeout(timer)
        return true
      }
      const failed = (error: Error) => {
        if (cleanup()) reject(error)
      }
      const abort = () => failed(new Error('Project 控制请求已取消'))
      const timer = setTimeout(() => failed(new Error('Project 控制请求超时')), 30_000)
      timer.unref()
      this.pending.set(id, {
        resolve: (result) => {
          if (cleanup()) resolve(result)
        },
        reject: failed,
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      Promise.resolve()
        .then(() => {
          if (!settled) return this.send(request, id)
        })
        .catch(() => failed(new Error('Project 控制请求发送失败')))
    })
  }

  receive(correlationId: string | undefined, result: ProjectRuntimeResult): boolean {
    const pending = correlationId ? this.pending.get(correlationId) : undefined
    if (!pending) return false
    pending.resolve(result)
    return true
  }

  close(): void {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('Project 控制连接已断开'))
  }
}
