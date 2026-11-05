import { constants, writeSync } from 'node:fs'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { releaseMetadata } from '@baton/protocol/release.mjs'
import type { TranscriptLine } from '@baton/protocol'
import { ensurePrivateDirectory, openPrivateFile, validatePrivateDirectory } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import { loadTranscriptSecrets, redactTranscript } from './redact.ts'

const readTail = async (file: FileHandle, size: number): Promise<Buffer> => {
  const length = Math.min(size, 64 * 1024)
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, size - length)
  return buffer.subarray(0, bytesRead)
}

const lastSequence = async (file: FileHandle): Promise<number> => {
  const size = (await file.stat()).size
  if (size === 0) return 0
  const tail = await readTail(file, size)
  const end = tail.lastIndexOf(0x0a)
  if (end < 0) return 0
  const start = tail.lastIndexOf(0x0a, end - 1) + 1
  const match = /"seq":(\d+)/.exec(tail.subarray(start, end).toString('utf8'))
  return match ? Number(match[1]) : 0
}

const openAppend = async (path: string): Promise<FileHandle> => {
  try {
    return await openPrivateFile(path, constants.O_RDWR | constants.O_APPEND)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    return open(
      path,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    )
  }
}

export interface TranscriptWriterOptions {
  readonly file: string
  readonly dataDirectory?: string
  readonly onError?: (error: unknown) => void
}

/**
 * 每条记录在事件发生时同步写入并立即返回；调用方不必等待 Turn 或 Run 结束。
 * 写入失败后停写后续记录，业务状态不受影响。
 */
export class TranscriptWriter {
  private sequence: number
  private failed = false
  private closed = false
  private readonly secrets: ReadonlyArray<string>
  private readonly release = releaseMetadata()

  private constructor(
    private readonly handle: FileHandle,
    sequence: number,
    secrets: ReadonlyArray<string>,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.sequence = sequence
    this.secrets = secrets
  }

  static async open(options: TranscriptWriterOptions): Promise<TranscriptWriter> {
    const directory = dirname(options.file)
    try {
      await ensurePrivateDirectory(directory)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      await mkdir(directory, { recursive: true, mode: 0o700 })
    }
    await validatePrivateDirectory(directory)
    const handle = await openAppend(options.file)
    const sequence = await lastSequence(handle).catch(() => 0)
    return new TranscriptWriter(handle, sequence, await loadTranscriptSecrets(options.dataDirectory), options.onError)
  }

  write(kind: string, data: unknown): void {
    if (this.closed || this.failed) return
    const line: TranscriptLine = {
      seq: ++this.sequence,
      ts: new Date().toISOString(),
      version: this.release.version,
      commit: this.release.commit,
      kind,
      data: redactTranscript(data, this.secrets) as typeof TranscriptLine.Type.data,
    }
    try {
      const bytes = Buffer.from(JSON.stringify(line) + '\n', 'utf8')
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(this.handle.fd, bytes, offset, bytes.length - offset)
        if (written === 0) throw new Error('Transcript write made no progress')
        offset += written
      }
    } catch (error) {
      this.failed = true
      this.onError?.(error)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (!this.failed) await this.handle.sync()
    } finally {
      await this.handle.close()
    }
  }
}
