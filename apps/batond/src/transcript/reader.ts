import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { TranscriptPage } from '@baton/protocol'
import { openPrivateFile, validatePrivateDirectory } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import { readOutputRetentionDays } from '../worker/full-output.ts'

export const transcriptPageBytes = 64 * 1024
const dayMs = 24 * 60 * 60 * 1000

export const threadGenerationDirectory = (dataDirectory: string, threadId: string, generation: string) =>
  join(dataDirectory, 'threads', threadId, generation)

export const threadTranscriptFile = (dataDirectory: string, threadId: string, generation: string) =>
  join(threadGenerationDirectory(dataDirectory, threadId, generation), 'transcript.jsonl')

export const projectRunTranscriptFile = (dataDirectory: string, projectId: string, runId: string) =>
  join(dataDirectory, 'project-runs', projectId, `${runId}.jsonl`)

export type TranscriptRead =
  | { readonly ok: true; readonly page: TranscriptPage }
  | { readonly ok: false; readonly code: string }

const failure = (code: string): TranscriptRead => ({ ok: false, code })

/** 按原始字节分页读取 JSONL；末尾未写完的一行保留可见并明确标记。 */
export const readTranscriptPage = async (
  file: string,
  rawOffset: string | number | undefined,
  retentionDays?: number,
): Promise<TranscriptRead> => {
  const offsetText = rawOffset === undefined ? '0' : String(rawOffset)
  if (!/^(0|[1-9][0-9]*)$/.test(offsetText)) return failure('invalid_cursor')
  const offset = Number(offsetText)
  if (!Number.isSafeInteger(offset)) return failure('invalid_cursor')
  try {
    const handle = await openPrivateFile(file)
    try {
      const info = await handle.stat()
      if (offset > info.size) return failure('invalid_cursor')
      const days = retentionDays ?? 30
      const expiresAt = new Date(info.mtimeMs + days * dayMs)
      if (expiresAt.getTime() <= Date.now()) return failure('transcript_expired')
      const length = Math.min(transcriptPageBytes, info.size - offset)
      const bytes = Buffer.alloc(length)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, offset + read)
        if (!bytesRead) return failure('transcript_changed')
        read += bytesRead
      }
      const next = offset + read
      let incompleteTail = false
      if (info.size > 0) {
        const last = Buffer.alloc(1)
        const { bytesRead } = await handle.read(last, 0, 1, info.size - 1)
        incompleteTail = bytesRead === 1 && last[0] !== 0x0a
      }
      return {
        ok: true,
        page: {
          offset,
          next_offset: next,
          total_bytes: info.size,
          expires_at: expiresAt.toISOString(),
          encoding: 'base64',
          data: bytes.toString('base64'),
          done: next === info.size,
          incomplete_tail: incompleteTail,
        },
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return failure(hasCode(error, 'ENOENT') ? 'transcript_missing' : 'transcript_unavailable')
  }
}

export const readThreadTranscriptPage = async (
  dataDirectory: string,
  threadId: string,
  generation: string,
  offset: string | number | undefined,
): Promise<TranscriptRead> => {
  const days = await readOutputRetentionDays(dataDirectory).catch(() => 30)
  return readTranscriptPage(threadTranscriptFile(dataDirectory, threadId, generation), offset, days)
}

export const readProjectRunTranscriptPage = async (
  dataDirectory: string,
  projectId: string,
  runId: string,
  offset: string | number | undefined,
): Promise<TranscriptRead> => {
  const days = await readOutputRetentionDays(dataDirectory).catch(() => 30)
  return readTranscriptPage(projectRunTranscriptFile(dataDirectory, projectId, runId), offset, days)
}

/** 本机只给 Thread ID 时选取最近写入的代次；同代次文件由 Thread 状态机维护。 */
export const latestThreadTranscriptFile = async (
  dataDirectory: string,
  threadId: string,
): Promise<string | undefined> => {
  const directory = join(dataDirectory, 'threads', threadId)
  let entries: string[]
  try {
    await validatePrivateDirectory(directory)
    entries = await readdir(directory)
  } catch {
    return undefined
  }
  let selected: { file: string; mtime: number } | undefined
  for (const entry of entries) {
    if (!/^[0-9a-zA-Z-]{1,64}$/.test(entry)) continue
    const file = join(directory, entry, 'transcript.jsonl')
    try {
      await validatePrivateDirectory(join(directory, entry))
      const info = await stat(file)
      if (!info.isFile()) continue
      if (!selected || info.mtimeMs > selected.mtime) selected = { file, mtime: info.mtimeMs }
    } catch {
      // 无 transcript 的代次继续查找。
    }
  }
  return selected?.file
}
