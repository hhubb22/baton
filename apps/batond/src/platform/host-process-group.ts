import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import * as Effect from 'effect/Effect'
import { PlatformError, hasCode } from './errors.ts'

export interface HostProcessGroupOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface HostProcessGroupPolicy {
  readonly pgid: number
  readonly restore: () => void
  readonly terminateChildren: (options?: HostProcessGroupOptions) => Promise<void>
  readonly waitQuiescent: (options?: HostProcessGroupOptions | AbortSignal) => Promise<void>
  readonly terminateChildrenEffect: (options?: HostProcessGroupOptions) => Effect.Effect<void, PlatformError>
  readonly waitQuiescentEffect: (options?: HostProcessGroupOptions | AbortSignal) => Effect.Effect<void, PlatformError>
}

interface Member {
  readonly pid: number
  readonly group: number
  readonly state: string
  readonly started: string
}

let installed = false

export interface HostProcessGroupInstallOptions {
  /**
   * Fold `detached: true` spawns back into the host group. Cursor's SDK does
   * not kill its own process group. Pi and ACP do `kill(-pid)` and must keep
   * the group they created.
   */
  readonly foldDetached?: boolean
}

/** Install only in an exclusive Agent host, before loading its SDK. */
export function installHostProcessGroup(options?: HostProcessGroupInstallOptions): HostProcessGroupPolicy {
  const foldDetached = options?.foldDetached !== false
  const posix = process.platform !== 'win32'
  if (posix && installed) throw new Error('Host process group guard is already installed')
  const pgid = process.pid
  if (posix) {
    const currentGroup = childProcess
      .execFileSync('/bin/ps', ['-p', String(pgid), '-o', 'pgid='], {
        encoding: 'utf8',
        timeout: 2000,
        env: { LC_ALL: 'C', TZ: 'UTC', PATH: '' },
      })
      .trim()
    if (currentGroup !== String(pgid)) throw new Error('Host must lead its own exclusive process group')
  }
  const originalSpawn = childProcess.spawn
  const originalFork = childProcess.fork
  const inspectProcess = childProcess.execFile
  let restored = false
  let terminating = false
  const inspections = new Map<number, Set<number>>()
  const inheritGroup = <F extends typeof originalSpawn | typeof originalFork>(original: F): F =>
    new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        if (terminating) throw new Error('Host process group is terminating')
        if (restored) return Reflect.apply(target, receiver, args)
        const index = Array.isArray(args[1]) || args[1] === undefined || args[1] === null ? 2 : 1
        const options = args[index]
        if (typeof options !== 'object' || options === null || Reflect.get(options, 'detached') !== true)
          return Reflect.apply(target, receiver, args)
        const inherited = [...args]
        inherited[index] = { ...options, detached: false }
        return Reflect.apply(target, receiver, inherited)
      },
    })
  if (posix && foldDetached) {
    childProcess.spawn = inheritGroup(originalSpawn)
    childProcess.fork = inheritGroup(originalFork)
    installed = true
    syncBuiltinESMExports()
  }
  const restore = () => {
    if (restored) return
    restored = true
    if (posix) {
      childProcess.spawn = originalSpawn
      childProcess.fork = originalFork
      syncBuiltinESMExports()
      installed = false
    }
  }
  const assertActive = () => {
    if (!posix) throw new Error('POSIX host process groups are unavailable on Windows')
    if (restored) throw new Error('Host process group policy is restored')
  }
  const run = async (terminate: boolean, options: HostProcessGroupOptions = {}): Promise<void> => {
    const operation = terminate ? 'terminate host group children' : 'wait for host group quiescence'
    try {
      assertActive()
      const timeoutMs = options.timeoutMs ?? 2000
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid host group timeout')
      const deadline = performance.now() + timeoutMs
      const remaining = () => {
        assertActive()
        options.signal?.throwIfAborted()
        const ms = Math.ceil(deadline - performance.now())
        if (ms <= 0) throw new Error('Host process group did not become quiescent before deadline')
        return ms
      }
      const members = async (pid?: number): Promise<Member[]> => {
        const timeout = remaining()
        const args =
          pid === undefined
            ? ['-axo', 'pid=,pgid=,stat=,lstart=']
            : ['-p', `${pgid},${pid}`, '-o', 'pid=,pgid=,stat=,lstart=']
        const rows = await new Promise<Member[]>((resolve, reject) => {
          // Retain every concurrent observer PID for this snapshot, even if another observer exits first.
          const excluded = new Set(inspections.keys())
          const inspector = inspectProcess(
            '/bin/ps',
            args,
            {
              encoding: 'utf8',
              timeout,
              signal: options.signal,
              maxBuffer: 4 * 1024 * 1024,
              env: { LC_ALL: 'C', TZ: 'UTC', PATH: '' },
            },
            (error, output) => {
              if (inspector.pid !== undefined) inspections.delete(inspector.pid)
              if (error) return reject(error)
              try {
                resolve(
                  output
                    .trim()
                    .split('\n')
                    .map((line) => {
                      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
                      if (!match) throw new Error('Invalid host process group inspection')
                      return {
                        pid: Number(match[1]),
                        group: Number(match[2]),
                        state: match[3],
                        started: match[4].trim(),
                      }
                    })
                    .filter((row) => !excluded.has(row.pid)),
                )
              } catch (cause) {
                reject(cause)
              }
            },
          )
          if (inspector.pid !== undefined) {
            excluded.add(inspector.pid)
            for (const observing of inspections.values()) observing.add(inspector.pid)
            inspections.set(inspector.pid, excluded)
          }
        })
        remaining()
        if (rows.find((row) => row.pid === pgid)?.group !== pgid)
          throw new Error('Host must lead its own exclusive process group')
        return rows.filter((row) => row.group === pgid && row.pid !== pgid && !/^[ZX]/.test(row.state))
      }
      if (terminate) terminating = true
      for (;;) {
        const children = await members()
        if (children.length === 0) return
        if (terminate) {
          for (const child of children) {
            // A new PGID inspection immediately precedes each signal; PPID never establishes ownership.
            const current = (await members(child.pid)).find((row) => row.pid === child.pid)
            if (!current || current.started !== child.started) continue
            remaining()
            if (inspections.has(child.pid)) continue
            try {
              process.kill(child.pid, 'SIGKILL')
            } catch (cause) {
              if (!hasCode(cause, 'ESRCH')) throw cause
            }
          }
        }
        await delay(Math.min(20, remaining()), undefined, { signal: options.signal })
      }
    } catch (cause) {
      throw new PlatformError(operation, cause)
    }
  }
  const terminateChildren = (options?: HostProcessGroupOptions) => run(true, options)
  const waitOptions = (options?: HostProcessGroupOptions | AbortSignal): HostProcessGroupOptions | undefined =>
    options instanceof AbortSignal ? { signal: options } : options
  const waitQuiescent = (options?: HostProcessGroupOptions | AbortSignal) => run(false, waitOptions(options))
  const asEffect = (terminate: boolean, options?: HostProcessGroupOptions): Effect.Effect<void, PlatformError> =>
    Effect.tryPromise({
      try: (signal) =>
        run(terminate, {
          ...options,
          signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        }),
      catch: (cause) => (cause instanceof PlatformError ? cause : new PlatformError('host process group', cause)),
    })
  return {
    pgid,
    restore,
    terminateChildren,
    waitQuiescent,
    terminateChildrenEffect: (options) => asEffect(true, options),
    waitQuiescentEffect: (options) => asEffect(false, waitOptions(options)),
  }
}

/** Keep the process configuration through exit; Scope release seals creation and reaps children. */
export const hostProcessGroupScoped = Effect.acquireRelease(Effect.sync(installHostProcessGroup), (policy) =>
  Effect.orDie(policy.terminateChildrenEffect()),
)
