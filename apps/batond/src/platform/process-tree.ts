import { setTimeout as delay } from 'node:timers/promises'
import { readProcessIdentity, systemCommand, validatePid, windowsTool, type ProcessIdentity } from './identity.ts'
import { hasCode } from './errors.ts'
import type { ReapResult } from './process-types.ts'

async function groupIsAlive(pgid: number): Promise<boolean> {
  const output = await systemCommand('/bin/ps', ['-axo', 'pid=,pgid=,stat='])
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 3 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]))
      throw new Error('Invalid process group inspection')
    if (Number(fields[1]) === pgid && !fields[2].startsWith('Z') && !fields[2].startsWith('X')) return true
  }
  return false
}

/** POSIX descendants must remain in their owned process group. Zombies cannot execute and count as reaped. */
export async function reapProcessTree(identity: ProcessIdentity, timeoutMs = 2000): Promise<ReapResult> {
  validatePid(identity.pid)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid reap timeout')
  const current = await readProcessIdentity(identity.pid)
  if (current && current.creationTime !== identity.creationTime) return { reaped: false, reason: 'identity-mismatch' }
  if (process.platform === 'win32') {
    if (!current) return { reaped: true }
    // CIM validation and taskkill are not atomic. Orphans of an exited intermediate process can escape /T.
    try {
      await systemCommand(windowsTool('taskkill.exe'), ['/PID', String(identity.pid), '/T', '/F'])
    } catch (error) {
      if (await readProcessIdentity(identity.pid)) throw error
    }
    const deadline = performance.now() + timeoutMs
    while (await readProcessIdentity(identity.pid)) {
      if (performance.now() >= deadline) return { reaped: false, reason: 'timeout' }
      await delay(20)
    }
    return { reaped: true }
  }
  try {
    process.kill(-identity.pid, 'SIGKILL')
  } catch (error) {
    // The final member can exit between identity lookup and signalling; EPERM still requires an empty group.
    const groupExited = hasCode(error, 'EPERM') && !(await groupIsAlive(identity.pid))
    if (!groupExited && !hasCode(error, 'ESRCH')) {
      console.error(
        'POSIX process group signal failed',
        {
          operation: 'reapProcessTree.kill',
          ownerPid: process.pid,
          pid: identity.pid,
          pgid: identity.pid,
          signal: 'SIGKILL',
          code: error instanceof Error && 'code' in error ? error.code : undefined,
          creationTime: identity.creationTime,
          observedCreationTime: current?.creationTime ?? null,
        },
        error,
      )
      throw error
    }
  }
  const deadline = performance.now() + timeoutMs
  while (await groupIsAlive(identity.pid)) {
    if (performance.now() >= deadline) return { reaped: false, reason: 'timeout' }
    await delay(20)
  }
  return { reaped: true }
}
