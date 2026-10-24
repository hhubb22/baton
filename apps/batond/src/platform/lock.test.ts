import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { acquireProcessLock, ProcessLockBusy, processLockIsHeld, readProcessLock } from './lock.ts'
import { writePrivateFile } from './private.ts'
import { readProcessIdentity } from './identity.ts'

const fixture = fileURLToPath(new URL('./test-fixtures/process.mjs', import.meta.url))
const directories: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function lockPath() {
  const directory = await mkdtemp(join(tmpdir(), 'baton-lock-'))
  directories.push(directory)
  return join(directory, 'worker.lock')
}

describe('process lock', () => {
  it('allows exactly one concurrent owner and release cannot delete a replacement owner', async () => {
    const path = await lockPath()
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => acquireProcessLock(path)))
    const successful = attempts.filter((attempt) => attempt.status === 'fulfilled')
    expect(successful).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(5)
    const original = successful[0].value
    expect(await processLockIsHeld(path)).toBe(true)
    await rm(path, { recursive: true })
    const replacement = await acquireProcessLock(path)
    await original()
    expect((await readProcessLock(path))?.token).toBe(replacement.record.token)
    await replacement()
    await replacement()
    expect(await readProcessLock(path)).toBeNull()
  })

  it('reclaims a killed owner while refusing a live owner', async () => {
    const path = await lockPath()
    const child = spawn(process.execPath, [fixture, 'lock', path], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(child)
    const lines = createInterface({ input: child.stdout })
    try {
      expect((await once(lines, 'line'))[0]).toBe('locked')
    } finally {
      lines.close()
    }
    await expect(acquireProcessLock(path)).rejects.toBeInstanceOf(ProcessLockBusy)
    const exit = once(child, 'exit')
    child.kill('SIGKILL')
    await exit
    expect(await processLockIsHeld(path)).toBe(false)
    const release = await acquireProcessLock(path)
    expect(release.record.pid).toBe(process.pid)
    await release()
  })

  it('uses creation time to reject a reused PID without signalling that process', async () => {
    const path = await lockPath()
    const original = await acquireProcessLock(path)
    await writePrivateFile(
      join(path, `${original.record.token}.json`),
      JSON.stringify({ ...original.record, creationTime: `${original.record.creationTime}-stale` }),
    )
    expect(await processLockIsHeld(path)).toBe(false)
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => acquireProcessLock(path)))
    const owners = attempts.filter((result) => result.status === 'fulfilled')
    expect(owners).toHaveLength(1)
    expect(await readProcessIdentity(process.pid)).not.toBeNull()
    await original()
    expect((await readProcessLock(path))?.token).toBe(owners[0].value.record.token)
    await owners[0].value()
  })
})
