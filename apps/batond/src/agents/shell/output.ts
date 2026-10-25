import { isUtf8 } from 'node:buffer'
import type { FullOutputReference } from '@baton/protocol'

export const outputBytes = 32 * 1024
const half = outputBytes / 2

export interface CommandOutput {
  readonly output: string
  readonly encoding?: 'base64'
  readonly exit_code: number
  readonly total_bytes: number
  readonly truncated: boolean
  readonly full_output?: FullOutputReference
}

/** Retains the first and last 16 KiB of combined stdout/stderr. */
export class BoundedOutput {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private total = 0

  constructor(private readonly retain?: (bytes: Buffer) => void) {}

  write(bytes: Buffer): void {
    this.retain?.(bytes)
    this.total += bytes.length
    const take = Math.min(half - this.head.length, bytes.length)
    if (take > 0) this.head = Buffer.concat([this.head, bytes.subarray(0, take)])
    const rest = bytes.subarray(take)
    if (rest.length >= half) this.tail = Buffer.from(rest.subarray(-half))
    else if (rest.length) this.tail = Buffer.concat([this.tail, rest]).subarray(-half)
  }

  result(exitCode: number): CommandOutput {
    const raw = Buffer.concat([this.head, this.tail])
    const text = raw.toString('utf8')
    const binary = !isUtf8(raw) || /[\p{Cc}]/u.test(text.replace(/[\n\r\t]/g, ''))
    // Bound repeated JSON escaping when the output becomes a nested tool result.
    const base64 = binary || Buffer.byteLength(JSON.stringify(text)) > 40 * 1024
    return {
      output: base64 ? raw.toString('base64') : text,
      ...(base64 ? { encoding: 'base64' as const } : {}),
      exit_code: exitCode,
      total_bytes: this.total,
      truncated: this.total > outputBytes,
    }
  }
}
