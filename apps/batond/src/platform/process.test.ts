import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { identityMatches, readProcessIdentity, type ProcessIdentity } from './identity.ts'
import {
  spawnOwnedProcess,
  spawnOwnedProcessScoped,
  startProcessWatchdog,
  reapProcessTree,
  type OwnedProcess,
  type ProcessWatchdog,
} from './process.ts'

const fixture = fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url))
const command = (role: string) => ({ file: process.execPath, args: [fixture, role] })
const watchdogs: ProcessWatchdog[] = []
const ownedProcesses: OwnedProcess[] = []
const children: ChildProcessWithoutNullStreams[] = []
const survivors: ProcessIdentity[] = []
async function trackSurvivors(pids: readonly number[]) {
  for (const pid of pids) {
    const identity = await readProcessIdentity(pid)
    if (identity) survivors.push(identity)
  }
}
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  for (const owned of ownedProcesses.splice(0)) await owned.reap()
  for (const watchdog of watchdogs.splice(0)) await watchdog.close()
  for (const identity of survivors.splice(0)) {
    if (await identityMatches(identity)) {
      try {
        process.kill(identity.pid, 'SIGKILL')
      } catch {}
    }
  }
})

async function firstLine(stream: NodeJS.ReadableStream): Promise<Record<string, number>> {
  const lines = createInterface({ input: stream })
  try {
    return JSON.parse((await once(lines, 'line'))[0])
  } finally {
    lines.close()
  }
}
async function gone(pids: readonly number[]) {
  const deadline = performance.now() + 4000
  while ((await Promise.all(pids.map(readProcessIdentity))).some(Boolean)) {
    if (performance.now() > deadline) throw new Error(`Processes still executing: ${pids.join(', ')}`)
    await delay(20)
  }
}
async function watchdog() {
  const instance = await startProcessWatchdog(command('watchdog'))
  watchdogs.push(instance)
  return instance
}

describe.skipIf(process.platform === 'win32')('owned POSIX processes', () => {
  it.each(['exited', 'running'] as const)('verifies %s groups when signalling is denied', async (state) => {
    const owned = await spawnOwnedProcess(
      { file: process.execPath, args: ['-e', state === 'exited' ? '' : 'setInterval(() => {}, 1000)'] },
      { watchdog: await watchdog() },
    )
    ownedProcesses.push(owned)
    if (state === 'exited') await owned.exited
    const kill = process.kill.bind(process)
    const failure = Object.assign(new Error('Group signal denied'), { code: 'EPERM' })
    const denied = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -owned.pid) throw failure
      return kill(pid, signal)
    })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      if (state === 'exited') {
        expect(await reapProcessTree(owned.record)).toEqual({ reaped: true })
        expect(diagnostic).not.toHaveBeenCalled()
      } else {
        await expect(reapProcessTree(owned.record)).rejects.toBe(failure)
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          'POSIX process group signal failed',
          expect.objectContaining({
            operation: 'reapProcessTree.kill',
            pid: owned.pid,
            pgid: owned.pid,
            signal: 'SIGKILL',
            code: 'EPERM',
          }),
          failure,
        )
      }
    } finally {
      denied.mockRestore()
      diagnostic.mockRestore()
    }
  })
  it.each(['reap', 'worker-kill', 'root-exit'] as const)(
    '%s reaps controlled SDK descendants without killing another Thread',
    async (mode) => {
      const unrelated = await spawnOwnedProcess(command('tree'), { watchdog: await watchdog() })
      ownedProcesses.push(unrelated)
      const unrelatedPids = await firstLine(unrelated.stdout)
      let pids: Record<string, number>
      let reap: () => Promise<unknown>
      if (mode !== 'worker-kill') {
        const owned = await spawnOwnedProcess(
          command(mode === 'root-exit' ? 'controlled-orphan-tree' : 'controlled-tree'),
          {
            watchdog: await watchdog(),
          },
        )
        ownedProcesses.push(owned)
        pids = await firstLine(owned.stdout)
        reap = async () => {
          if (mode === 'root-exit') {
            await owned.exited
            await gone([pids.root, pids.branch])
            expect(await readProcessIdentity(pids.leaf)).not.toBeNull()
          }
          expect(await owned.reap()).toEqual({ reaped: true })
          if (mode === 'reap') expect(await owned.exited).toEqual({ code: null, signal: 'SIGKILL' })
          expect(await owned.close()).toEqual({ reaped: true })
        }
      } else {
        const worker = spawn(command('worker-controlled-tree').file, command('worker-controlled-tree').args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        children.push(worker)
        pids = await firstLine(worker.stdout)
        reap = async () => {
          const exited = once(worker, 'exit')
          worker.kill('SIGKILL')
          await exited
        }
      }
      await trackSurvivors(Object.values(pids))
      await reap()
      await gone(Object.values(pids))
      for (const pid of Object.values(unrelatedPids)) expect(await readProcessIdentity(pid)).not.toBeNull()
    },
  )

  it('cancels pending startup registration and reaps before rejecting', async () => {
    const guard = await watchdog()
    let notify!: (pid: number) => void
    const registering = new Promise<number>((resolve) => {
      notify = resolve
    })
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const controller = new AbortController()
    const startup = spawnOwnedProcess(
      { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      {
        signal: controller.signal,
        watchdog: {
          ...guard,
          async register(identity) {
            await guard.register(identity)
            notify(identity.pid)
            await gate
          },
        },
      },
    )
    const pid = await registering
    const rejection = expect(startup).rejects.toThrow('startup cancelled')
    try {
      controller.abort(new Error('startup cancelled'))
      await gone([pid])
    } finally {
      unblock()
    }
    await rejection
  })

  it('Effect interruption waits for pending acquisition cleanup', async () => {
    const guard = await watchdog()
    let notify!: (pid: number) => void
    const registering = new Promise<number>((resolve) => {
      notify = resolve
    })
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const fiber = Effect.runFork(
      Effect.scoped(
        spawnOwnedProcessScoped(
          { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
          {
            watchdog: {
              ...guard,
              async register(identity) {
                await guard.register(identity)
                notify(identity.pid)
                await gate
              },
            },
          },
        ),
      ),
    )
    const pid = await registering
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    try {
      await gone([pid])
    } finally {
      unblock()
    }
    await interrupted
    expect(await readProcessIdentity(pid)).toBeNull()
  })

  it('detached Workers survive their batond launcher exiting', async () => {
    const launcher = spawn(command('launcher').file, command('launcher').args, { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(launcher)
    const exited = once(launcher, 'exit')
    const { worker } = await firstLine(launcher.stdout)
    await trackSurvivors([worker])
    await exited
    expect(await readProcessIdentity(worker)).not.toBeNull()
  })
})
