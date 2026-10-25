import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import { currentBatondCommand } from '../daemon/host.ts'
import { readProcessIdentity, type ProcessIdentity } from '../platform/identity.ts'
import { reapProcessTree } from '../platform/process-tree.ts'
import type { ProcessWatchdog } from '../platform/process-types.ts'
import { startProcessWatchdog } from '../platform/watchdog.ts'
import { AgentHostError } from './protocol.ts'

/**
 * Process groups an upstream adapter created outside the host's own group.
 *
 * The host already leads its own group. Cursor folds detached spawns back into
 * that group, so killing the host group covers them. Pi and ACP keep their own
 * process group; those groups are registered here and reaped on release, and a
 * crashed host cannot leave them behind because the watchdog still owns them.
 */
export interface ProcessRegistrar {
  /** Returns true when the process groups of `pid` were registered separately. */
  readonly register: (pid: number) => Effect.Effect<boolean, AgentHostError>
  readonly release: (pid: number) => Effect.Effect<void, AgentHostError>
  readonly close: Effect.Effect<void>
}

const execFileAsync = promisify(execFile)

const readGroup = async (pid: number): Promise<number | undefined> => {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
      encoding: 'utf8',
      timeout: 2000,
      env: { LC_ALL: 'C', TZ: 'UTC', PATH: '' },
    })
    const group = Number(stdout.trim())
    return Number.isSafeInteger(group) && group > 1 ? group : undefined
  } catch {
    return undefined
  }
}

export const makeProcessRegistrar = () =>
  Effect.sync(() => {
    const separate = new Map<number, ProcessIdentity>()
    let watchdog: ProcessWatchdog | undefined
    let pending: ReturnType<typeof startProcessWatchdog> | undefined
    const fail = (operation: string, cause: unknown) =>
      new AgentHostError({ message: `Agent host could not ${operation}: ${String(cause)}` })
    const ensureWatchdog = () => {
      if (watchdog) return Promise.resolve(watchdog)
      if (!pending) {
        const command = currentBatondCommand()
        pending = startProcessWatchdog({
          file: command.executable,
          args: [...command.args, 'watchdog'],
        }).then(
          (started) => {
            watchdog = started
            return started
          },
          (cause: unknown) => {
            pending = undefined
            throw cause
          },
        )
      }
      return pending
    }
    const registrar: ProcessRegistrar = {
      register: (pid) =>
        process.platform === 'win32'
          ? Effect.succeed(false)
          : Effect.gen(function* () {
              const group = yield* Effect.promise(() => readGroup(pid))
              if (group === undefined || group === process.pid) return false
              const identity = yield* Effect.promise(() => readProcessIdentity(group))
              if (!identity) return false
              const started = yield* Effect.tryPromise({
                try: ensureWatchdog,
                catch: (cause) => fail('start its watchdog', cause),
              })
              yield* Effect.tryPromise({
                try: () => started.register(identity),
                catch: (cause) => fail('register a process group', cause),
              })
              separate.set(group, identity)
              return true
            }),
      release: (pid) =>
        Effect.gen(function* () {
          const group = yield* Effect.promise(() => readGroup(pid))
          const identity = (group === undefined ? undefined : separate.get(group)) ?? separate.get(pid)
          const started = watchdog
          if (!identity || started === undefined) return
          // The adapter's own kill runs first. This still ends a group it missed.
          const result = yield* Effect.tryPromise({
            try: () => reapProcessTree(identity, 5000),
            catch: (cause) => fail('reap a process group', cause),
          })
          if (!result.reaped && result.reason !== 'identity-mismatch')
            return yield* fail('reap a process group', result.reason ?? 'cleanup was not confirmed')
          yield* Effect.tryPromise({
            try: () => started.unregister(identity),
            catch: (cause) => fail('release a process group', cause),
          })
          separate.delete(identity.pid)
        }).pipe(Effect.tapError((error) => Effect.logWarning(error.message))),
      close: Effect.suspend(() => {
        const started = watchdog
        watchdog = undefined
        return started === undefined ? Effect.void : Effect.promise(() => started.close().catch(() => {}))
      }),
    }
    return registrar
  })
