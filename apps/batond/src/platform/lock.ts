import { randomUUID } from 'node:crypto'
import { readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as Effect from 'effect/Effect'
import { ensurePrivateDirectory, readPrivateFile, validatePrivateDirectory, writePrivateFileAtomic } from './files.ts'
import { hasCode, platformEffect } from './errors.ts'
import { identityMatches, readProcessIdentity, type ProcessIdentity } from './identity.ts'

export interface ProcessLockRecord extends ProcessIdentity {
  readonly token: string
}
export type ProcessLock = (() => Promise<void>) & { readonly record: ProcessLockRecord }

export class ProcessLockBusy extends Error {
  readonly _tag = 'ProcessLockBusy'
  readonly path: string
  readonly owner: ProcessLockRecord | null
  constructor(path: string, owner: ProcessLockRecord | null) {
    super(`Process lock is held or cannot safely be reclaimed: ${path}`)
    this.path = path
    this.owner = owner
  }
}

function parseRecord(raw: Buffer, token: string): ProcessLockRecord {
  const value: unknown = JSON.parse(raw.toString('utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pid' in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 1 ||
    !('creationTime' in value) ||
    typeof value.creationTime !== 'string' ||
    !value.creationTime ||
    !('token' in value) ||
    value.token !== token
  )
    throw new Error('Invalid process lock record')
  return { pid: Number(value.pid), creationTime: value.creationTime, token }
}

/** An existing empty, malformed or unsafe lock is an error, never evidence that it is free. */
export async function readProcessLock(path: string): Promise<ProcessLockRecord | null> {
  try {
    await validatePrivateDirectory(path)
    const entries = await readdir(path)
    if (entries.length !== 1 || !/^[\da-f-]{36}\.json$/.test(entries[0])) throw new ProcessLockBusy(path, null)
    const token = entries[0].slice(0, -5)
    return parseRecord(await readPrivateFile(join(path, entries[0])), token)
  } catch (error) {
    // Recheck the directory: only a missing lock directory means no lock.
    if (hasCode(error, 'ENOENT')) {
      try {
        await validatePrivateDirectory(path)
      } catch (missing) {
        if (hasCode(missing, 'ENOENT')) return null
        throw missing
      }
      throw new ProcessLockBusy(path, null)
    }
    throw error
  }
}

const isProcessAlive = (record: ProcessIdentity): Promise<boolean> => identityMatches(record)

export async function processLockIsHeld(path: string): Promise<boolean> {
  const record = await readProcessLock(path)
  return record !== null && (await isProcessAlive(record))
}

async function removeRecord(path: string, record: ProcessLockRecord): Promise<void> {
  // Token-specific removal cannot unlink a replacement owner's file.
  const current = await readProcessLock(path)
  if (
    !current ||
    current.token !== record.token ||
    current.creationTime !== record.creationTime ||
    current.pid !== record.pid
  )
    return
  await unlink(join(path, `${record.token}.json`)).catch((error: unknown) => {
    if (!hasCode(error, 'ENOENT')) throw error
  })
  await rmdir(path).catch((error: unknown) => {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error
  })
}

/** path is a lock directory. Publish a fully initialized nonempty directory atomically. */
export async function acquireProcessLock(path: string): Promise<ProcessLock> {
  await validatePrivateDirectory(dirname(path))
  const identity = await readProcessIdentity(process.pid)
  if (!identity) throw new Error('Cannot read own process creation time')
  const record: ProcessLockRecord = { ...identity, token: randomUUID() }
  const candidate = join(dirname(path), `.lock-${record.token}`)
  await ensurePrivateDirectory(candidate)
  const file = `${record.token}.json`
  try {
    await writePrivateFileAtomic(join(candidate, file), JSON.stringify(record))
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rename(candidate, path)
        let released = false
        return Object.assign(
          async () => {
            if (released) return
            await removeRecord(path, record)
            released = true
          },
          { record },
        )
      } catch (error) {
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EPERM')) throw error
        const existing = await readProcessLock(path)
        if (!existing) continue
        if (await isProcessAlive(existing)) throw new ProcessLockBusy(path, existing)
        await removeRecord(path, existing)
      }
    }
    throw new ProcessLockBusy(path, await readProcessLock(path))
  } finally {
    await unlink(join(candidate, file)).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error
    })
    await rmdir(candidate).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error
    })
  }
}

/** Scope finalization defects on release failure so callers cannot treat a leaked lock as clean shutdown. */
export const acquireProcessLockScoped = (path: string) =>
  Effect.acquireRelease(
    platformEffect('acquire process lock', () => acquireProcessLock(path)),
    (release) => Effect.orDie(platformEffect('release process lock', release)),
  )
