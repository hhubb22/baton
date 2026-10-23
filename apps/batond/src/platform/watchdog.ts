import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { readProcessIdentity, validatePid, type ProcessIdentity } from './identity.ts'
import type { ProcessCommand, ProcessWatchdog } from './process-types.ts'
import { reapProcessTree } from './process-tree.ts'

interface WatchdogMessage {
  id: number
  action: 'add' | 'remove'
  identity: ProcessIdentity
}

function parseMessage(line: string): WatchdogMessage {
  const value: unknown = JSON.parse(line)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !Number.isSafeInteger(value.id) ||
    !('action' in value) ||
    (value.action !== 'add' && value.action !== 'remove') ||
    !('identity' in value) ||
    typeof value.identity !== 'object' ||
    value.identity === null ||
    !('pid' in value.identity) ||
    typeof value.identity.pid !== 'number' ||
    !('creationTime' in value.identity) ||
    typeof value.identity.creationTime !== 'string' ||
    !value.identity.creationTime
  )
    throw new Error('Invalid watchdog registration')
  validatePid(value.identity.pid)
  return {
    id: Number(value.id),
    action: value.action,
    identity: { pid: value.identity.pid, creationTime: value.identity.creationTime },
  }
}

/** batond watchdog CLI entry. The Worker is the only holder of this child's stdin write end. */
export async function runWatchdogCommand(): Promise<void> {
  if (process.platform === 'win32') throw new Error('POSIX watchdog is unavailable on Windows')
  const groups = new Map<number, ProcessIdentity>()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  process.stdout.on('error', () => {
    /* EOF cleanup still runs if the Worker has exited. */
  })
  const failures: unknown[] = []
  try {
    process.stdout.write('{"id":0}\n')
    for await (const line of lines) {
      if (line.length > 4096) throw new Error('Oversized watchdog registration')
      const message = parseMessage(line)
      const { identity } = message
      if (message.action === 'add') {
        const current = await readProcessIdentity(identity.pid)
        if (current && current.creationTime !== identity.creationTime)
          throw new Error('Watchdog process identity mismatch')
        groups.set(identity.pid, identity)
      } else if (groups.get(identity.pid)?.creationTime === identity.creationTime) {
        groups.delete(identity.pid)
      }
      process.stdout.write(`${JSON.stringify({ id: message.id })}\n`)
    }
  } catch (error) {
    failures.push(error)
  } finally {
    lines.close()
  }
  const results = await Promise.allSettled([...groups.values()].map((identity) => reapProcessTree(identity)))
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
    else if (!result.value.reaped) failures.push(new Error('Watchdog could not confirm an owned group exited'))
  }
  if (failures.length) throw new AggregateError(failures, 'Watchdog cleanup failed')
}

export async function startProcessWatchdog(command: ProcessCommand): Promise<ProcessWatchdog> {
  if (process.platform === 'win32') throw new Error('POSIX watchdog is unavailable on Windows')
  const child = spawn(command.file, [...(command.args ?? [])], {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const known = new Map<number, ProcessIdentity>()
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  let failure: Error | undefined
  let closed = false
  let nextId = 1
  const fail = (error: Error) => {
    failure ??= error
    for (const entry of pending.values()) entry.reject(failure)
    pending.clear()
  }
  // Attach before awaiting spawn so immediate exec failures cannot become unhandled errors.
  child.on('error', fail)
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Watchdog exited: ${code ?? signal}`))
      if (!closed) {
        fail(new Error('Watchdog exited before its owner'))
        // Best effort after watchdog failure; callers must stop execution on registration failure.
        for (const identity of known.values()) void reapProcessTree(identity).catch(() => {})
      }
    })
  })
  void exit.catch(() => {})
  const request = (id: number, write?: WatchdogMessage): Promise<void> =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Watchdog acknowledgement timed out'))
      }, 5000)
      pending.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      if (write)
        child.stdin.write(`${JSON.stringify(write)}\n`, (error) => {
          if (error) fail(error)
        })
    })
  child.stdin.on('error', fail)
  const ready = request(0)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', (line) => {
    try {
      const ack: unknown = JSON.parse(line)
      if (
        typeof ack !== 'object' ||
        ack === null ||
        !('id' in ack) ||
        typeof ack.id !== 'number' ||
        !pending.has(ack.id)
      )
        throw new Error('Unexpected watchdog acknowledgement')
      pending.get(ack.id)!.resolve()
      pending.delete(ack.id)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      child.stdin.end()
    }
  })
  try {
    await ready
  } catch (error) {
    child.stdin.end()
    await exit.catch(() => {})
    throw error
  }
  if (!child.pid) throw new Error('Watchdog has no PID')
  return {
    pid: child.pid,
    async register(identity) {
      if (closed) throw new Error('Watchdog is closed')
      known.set(identity.pid, identity)
      await request(nextId, { id: nextId++, action: 'add', identity })
    },
    async unregister(identity) {
      if (closed) throw new Error('Watchdog is closed')
      await request(nextId, { id: nextId++, action: 'remove', identity })
      known.delete(identity.pid)
    },
    async close() {
      if (!closed) {
        closed = true
        child.stdin.end()
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        await Promise.race([
          exit,
          once(controller.signal, 'abort').then(() => {
            throw new Error('Watchdog close timed out')
          }),
        ])
      } finally {
        clearTimeout(timer)
        lines.close()
      }
    },
  }
}
