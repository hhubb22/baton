import { constants, writeSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Schema } from 'effect'
import {
  FullOutputReference,
  StorageGeneration,
  UUID,
  type SessionRequest,
  type SessionResult,
  type WorkerOpenConfig,
} from '@baton/protocol'
import {
  ensurePrivateDirectory,
  openPrivateFile,
  validatePrivateDirectory,
  writePrivateFileAtomic,
} from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import { processLockIsHeld } from '../platform/lock.ts'

export const fullOutputPageBytes = 12 * 1024
const defaultOutputRetentionDays = 30
const dayMs = 24 * 60 * 60 * 1000
const Config = Schema.Struct({ retention_days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })) })
const Record = Schema.Struct({
  ...FullOutputReference.fields,
  thread_id: UUID,
})

async function readJson(path: string): Promise<unknown> {
  const file = await openPrivateFile(path)
  try {
    if ((await file.stat()).size > 4096) throw new Error('Output metadata exceeds size limit')
    const bytes = Buffer.alloc(4097)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 4096) throw new Error('Output metadata exceeds size limit')
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await file.close()
  }
}

export async function readOutputRetentionDays(dataDirectory?: string): Promise<number> {
  if (dataDirectory === undefined) return defaultOutputRetentionDays
  try {
    return Schema.decodeUnknownSync(Config)(await readJson(join(dataDirectory, 'output-retention.json'))).retention_days
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return defaultOutputRetentionDays
    throw error
  }
}

export class FullOutputStore {
  readonly directory: string
  constructor(readonly threadDirectory: string) {
    this.directory = join(threadDirectory, 'full-output')
  }

  async begin(config: Pick<WorkerOpenConfig, 'thread_id' | 'storage_generation'>, retentionDays: number) {
    await validatePrivateDirectory(this.threadDirectory)
    await ensurePrivateDirectory(this.directory)
    const id = randomUUID()
    const path = join(this.directory, `${id}.bin`)
    await writePrivateFileAtomic(path, '')
    const file = await openPrivateFile(path, constants.O_WRONLY)
    const expiresAt = new Date(Date.now() + retentionDays * dayMs).toISOString()
    let total = 0
    let closed = false
    let failure: unknown
    return {
      write(bytes: Buffer) {
        if (closed || failure) return
        try {
          let offset = 0
          while (offset < bytes.length) {
            const written = writeSync(file.fd, bytes, offset, bytes.length - offset)
            if (written === 0) throw new Error('Output write made no progress')
            offset += written
          }
          total += bytes.length
        } catch (error) {
          failure = error
        }
      },
      finish: async (): Promise<FullOutputReference> => {
        if (closed) throw new Error('Output is already closed')
        closed = true
        try {
          if (failure) throw failure
          await file.sync()
        } finally {
          await file.close()
        }
        const reference: FullOutputReference = {
          id,
          storage_generation: config.storage_generation,
          total_bytes: total,
          expires_at: expiresAt,
        }
        await writePrivateFileAtomic(
          join(this.directory, `${id}.json`),
          JSON.stringify({ ...reference, thread_id: config.thread_id }),
        )
        return reference
      },
      close: async () => {
        if (!closed) {
          closed = true
          await file.close()
        }
      },
    }
  }

  async put(
    config: Pick<WorkerOpenConfig, 'thread_id' | 'storage_generation'>,
    content: Buffer,
    retentionDays: number,
  ) {
    const writer = await this.begin(config, retentionDays)
    try {
      writer.write(content)
      return await writer.finish()
    } finally {
      await writer.close()
    }
  }

  async read(request: SessionRequest): Promise<SessionResult> {
    const base: SessionResult = {
      type: 'session.result',
      operation_id: request.operation_id,
      session_id: request.session_id,
      ok: false,
      gap: false,
    }
    if (request.action !== 'full_output' || !request.output_id || !request.storage_generation)
      return { ...base, code: 'invalid_request' }
    try {
      Schema.decodeUnknownSync(UUID)(request.output_id)
      Schema.decodeUnknownSync(StorageGeneration)(request.storage_generation)
      await validatePrivateDirectory(this.threadDirectory)
      await validatePrivateDirectory(this.directory)
      const record = Schema.decodeUnknownSync(Record)(await readJson(join(this.directory, `${request.output_id}.json`)))
      if (
        record.thread_id !== request.session_id ||
        record.id !== request.output_id ||
        record.storage_generation !== request.storage_generation
      )
        return { ...base, code: 'output_identity_mismatch' }
      if (Date.parse(record.expires_at) <= Date.now()) {
        await this.remove(record.id)
        return { ...base, code: 'output_expired' }
      }
      const rawOffset = request.cursor ?? '0'
      if (!/^(0|[1-9][0-9]*)$/.test(rawOffset)) return { ...base, code: 'invalid_cursor' }
      const offset = Number(rawOffset)
      if (!Number.isSafeInteger(offset) || offset > record.total_bytes) return { ...base, code: 'invalid_cursor' }
      const file = await openPrivateFile(join(this.directory, `${record.id}.bin`))
      try {
        if ((await file.stat()).size !== record.total_bytes) return { ...base, code: 'output_changed' }
        const bytes = Buffer.alloc(Math.min(fullOutputPageBytes, record.total_bytes - offset))
        let read = 0
        while (read < bytes.length) {
          const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read)
          if (!bytesRead) return { ...base, code: 'output_changed' }
          read += bytesRead
        }
        const next = offset + read
        return {
          ...base,
          ok: true,
          cursor: String(next),
          full_output: {
            output_id: record.id,
            storage_generation: record.storage_generation,
            offset,
            next_offset: next,
            total_bytes: record.total_bytes,
            expires_at: record.expires_at,
            encoding: 'base64',
            data: bytes.toString('base64'),
            done: next === record.total_bytes,
          },
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      return { ...base, code: hasCode(error, 'ENOENT') ? 'output_missing' : 'output_unavailable' }
    }
  }

  private async remove(id: string) {
    for (const extension of ['json', 'bin']) {
      await unlink(join(this.directory, `${id}.${extension}`)).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error
      })
    }
  }

  async prune(now = Date.now()) {
    await validatePrivateDirectory(this.threadDirectory)
    try {
      await validatePrivateDirectory(this.directory)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return
      throw error
    }
    for (const entry of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.(json|bin)$/.test(entry)) continue
      if (entry.endsWith('.json')) {
        const record = Schema.decodeUnknownSync(Record)(await readJson(join(this.directory, entry)))
        if (Date.parse(record.expires_at) <= now) await this.remove(record.id)
      } else {
        if (await processLockIsHeld(join(this.threadDirectory, 'worker.lock'))) continue
        try {
          const file = await openPrivateFile(join(this.directory, entry))
          const stat = await file.stat().finally(() => file.close())
          // Incomplete writes have no published metadata and are reclaimed after 24 hours without writes.
          if (stat.mtimeMs + dayMs > now) continue
          try {
            await readJson(join(this.directory, entry.replace(/\.bin$/, '.json')))
          } catch (error) {
            if (!hasCode(error, 'ENOENT')) throw error
            await unlink(join(this.directory, entry))
          }
        } catch (error) {
          if (!hasCode(error, 'ENOENT')) throw error
        }
      }
    }
  }
}

export async function pruneDeviceOutputs(dataDirectory: string, now = Date.now()) {
  await validatePrivateDirectory(dataDirectory)
  for (const kind of ['threads', 'executions']) {
    const directory = join(dataDirectory, kind)
    try {
      await validatePrivateDirectory(directory)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue
      throw error
    }
    for (const name of await readdir(directory)) {
      if (Schema.is(UUID)(name)) await new FullOutputStore(join(directory, name)).prune(now)
    }
  }
}
