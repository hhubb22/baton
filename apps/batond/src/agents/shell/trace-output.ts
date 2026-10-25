import { TextDecoder } from 'node:util'
import { BoundedOutput, type CommandOutput } from './output.ts'

export interface CommandTraceOutput extends CommandOutput {
  readonly original_output_json_bytes: number
}

/** Counts the complete JSON string while retaining at most 192 KiB of raw output. */
export class TraceOutput {
  private readonly output = new BoundedOutput(undefined, 192 * 1024)
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private textBytes = 2
  private binary = false
  private decoded = false

  private count(text: string): void {
    this.textBytes += Buffer.byteLength(JSON.stringify(text)) - 2
    if (/[\p{Cc}]/u.test(text.replace(/[\n\r\t]/g, ''))) this.binary = true
  }

  write(bytes: Buffer): void {
    this.output.write(bytes)
    if (this.decoded) throw new Error('Trace output is already finalized')
    try {
      this.count(this.decoder.decode(bytes, { stream: true }))
    } catch {
      this.binary = true
    }
  }

  result(exitCode: number): CommandTraceOutput {
    if (!this.decoded) {
      try {
        this.count(this.decoder.decode())
      } catch {
        this.binary = true
      }
      this.decoded = true
    }
    const result = this.output.result(exitCode, this.binary)
    return {
      ...result,
      original_output_json_bytes:
        result.encoding === 'base64' ? 4 * Math.ceil(result.total_bytes / 3) + 2 : this.textBytes,
    }
  }
}
