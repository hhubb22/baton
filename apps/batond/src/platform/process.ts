import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { PlatformError, platformEffect, hasCode } from './errors.ts'
import { readProcessIdentity } from './identity.ts'
import { reapProcessTree } from './process-tree.ts'
import type {
  OwnedProcess,
  ProcessCommand,
  ProcessExit,
  ProcessRecord,
  ProcessRecordCallbacks,
  ReapResult,
  SpawnOwnedProcessOptions,
} from './process-types.ts'

export type * from './process-types.ts'
export { readProcessIdentity } from './identity.ts'
export { reapProcessTree } from './process-tree.ts'
export { startProcessWatchdog, runWatchdogCommand } from './watchdog.ts'

/** Piped stdio and a new POSIX session/process group; never use this API to launch a persistent Worker. */
export async function spawnOwnedProcess(
  command: ProcessCommand,
  options: SpawnOwnedProcessOptions = {},
): Promise<OwnedProcess> {
  options.signal?.throwIfAborted()
  if (process.platform !== 'win32' && !options.watchdog)
    throw new Error('POSIX owned processes require a Worker watchdog')
  if (process.platform === 'win32' && !options.records)
    throw new Error('Windows owned processes require durable process record callbacks')
  const child: ChildProcessWithoutNullStreams = spawn(command.file, [...(command.args ?? [])], {
    cwd: command.cwd,
    env: command.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: null, signal: null }))
  })
  // Stream consumers can observe pipe failures; keep cleanup writes from throwing an unhandled EPIPE.
  child.stdin.on('error', () => {})
  let record: ProcessRecord | undefined
  let persistenceAttempted = false
  let registrationAttempted = false
  const abort = () => {
    if (!child.pid) return
    if (record) {
      void reapProcessTree(record, options.reapTimeoutMs).catch(() => {})
    } else if (process.platform !== 'win32') {
      // Before identity capture, only signal a still-running direct child.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (!hasCode(error, 'ESRCH')) child.kill('SIGKILL')
        }
      }
    } else {
      child.kill('SIGKILL')
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  let reapInFlight: Promise<ReapResult> | undefined
  let completed: ReapResult | undefined
  const reap = (): Promise<ReapResult> => {
    if (completed) return Promise.resolve(completed)
    return (reapInFlight ??= (async () => {
      if (!record) throw new Error('Owned process has not been registered')
      const result = await reapProcessTree(record, options.reapTimeoutMs)
      if (result.reaped) {
        await exited
        if (registrationAttempted) {
          await options.watchdog!.unregister(record)
          registrationAttempted = false
        }
        if (persistenceAttempted) {
          await options.records!.remove(record)
          persistenceAttempted = false
        }
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        completed = result
      }
      return result
    })().finally(() => {
      reapInFlight = undefined
    }))
  }
  try {
    options.onSpawn?.(child)
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (!child.pid) throw new Error('Spawned child has no PID')
    const identity = await readProcessIdentity(child.pid)
    // A fast root can exit while descendants still hold its process group and pipes.
    record = {
      ...(identity ?? { pid: child.pid, creationTime: `exited:${randomUUID()}` }),
      role: options.role ?? 'agent',
    }
    if (options.watchdog) {
      registrationAttempted = true
      await options.watchdog.register(record)
    }
    options.signal?.throwIfAborted()
    if (options.records) {
      persistenceAttempted = true
      await options.records.add(record)
    }
    options.signal?.throwIfAborted()
    return {
      child,
      pid: child.pid,
      record,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      reap,
      close: reap,
    }
  } catch (error) {
    abort()
    if (child.pid) {
      record ??= { pid: child.pid, creationTime: `unregistered:${randomUUID()}`, role: options.role ?? 'agent' }
      try {
        const result = await reap()
        if (!result.reaped) throw new Error(`Startup cleanup was not confirmed: ${result.reason}`, { cause: error })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Owned process startup and cleanup failed', {
          cause: cleanupError,
        })
      }
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

/** Detached Workers survive batond shutdown. Their Worker lock and authenticated IPC establish ownership. */
export async function spawnDetachedWorker(command: ProcessCommand): Promise<number> {
  const child = spawn(command.file, [...(command.args ?? [])], {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (!child.pid) throw new Error('Worker has no PID')
  child.unref()
  return child.pid
}

/** Windows crash recovery. Entries with reused PIDs remain untouched and are reported as mismatches. */
export async function recoverRecordedProcesses(
  records: readonly ProcessRecord[],
  callbacks: Pick<ProcessRecordCallbacks, 'remove'>,
): Promise<readonly { record: ProcessRecord; result: ReapResult }[]> {
  if (process.platform !== 'win32') throw new Error('Persistent process recovery is Windows-only')
  const results = []
  for (const record of records) {
    const result = await reapProcessTree(record)
    if (result.reaped || result.reason === 'identity-mismatch') await callbacks.remove(record)
    results.push({ record, result })
  }
  return results
}

/** Interruption aborts startup and waits for its cleanup; a late successful acquisition is reaped too. */
export const spawnOwnedProcessEffect = (
  command: ProcessCommand,
  options: SpawnOwnedProcessOptions = {},
): Effect.Effect<OwnedProcess, PlatformError> =>
  Effect.callback((resume, signal) => {
    const startup = spawnOwnedProcess(command, {
      ...options,
      signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
    })
    void startup.then(
      (owned) => resume(Effect.succeed(owned)),
      (cause) => resume(Effect.fail(new PlatformError('spawn owned process', cause))),
    )
    return Effect.orDie(
      platformEffect('cancel owned process startup', () =>
        startup.then(
          async (owned) => {
            const result = await owned.reap()
            if (!result.reaped) throw new Error(`Startup cleanup was not confirmed: ${result.reason}`)
          },
          (error: unknown) => {
            if (error instanceof AggregateError) throw error
          },
        ),
      ),
    )
  })

export const spawnOwnedProcessScoped = (command: ProcessCommand, options: SpawnOwnedProcessOptions = {}) =>
  Effect.acquireRelease(
    spawnOwnedProcessEffect(command, options),
    (owned) =>
      Effect.orDie(
        platformEffect('reap owned process', async () => {
          const result = await owned.reap()
          if (!result.reaped) throw new Error(`Process cleanup was not confirmed: ${result.reason}`)
        }),
      ),
    { interruptible: true },
  )
