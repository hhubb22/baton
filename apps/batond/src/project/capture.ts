import type { Readable } from 'node:stream'

/** Attach in onSpawn; retain bounded output even if the child exits during registration. */
export function captureRuntimeOutput(
  input: Readable,
  maximum: number,
  firstLine: boolean,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [],
      length = 0,
      complete = false
    const finish = (error?: Error, bytes?: Buffer) => {
      if (complete) return
      complete = true
      signal.removeEventListener('abort', abort)
      chunks = []
      if (error) reject(error)
      else resolve(bytes!)
    }
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Runtime 输出读取已取消'))
    input.on('data', (chunk: Buffer) => {
      if (complete) return
      const end = firstLine ? chunk.indexOf(10) : -1
      const bytes = end < 0 ? chunk : chunk.subarray(0, end)
      length += bytes.length
      if (length > maximum) {
        finish(new Error('Project Runtime 输出超限'))
        return
      }
      chunks.push(bytes)
      if (end >= 0) finish(undefined, Buffer.concat(chunks, length))
    })
    input.once('end', () => {
      if (complete) return
      if (firstLine) finish(new Error('订阅登录未返回有效设备码'))
      else finish(undefined, Buffer.concat(chunks, length))
    })
    input.once('error', (error) => finish(error))
    input.once('close', () => {
      if (!complete) finish(new Error('Project Runtime 输出提前关闭'))
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
