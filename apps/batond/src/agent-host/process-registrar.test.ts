import { Effect, Exit } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ProcessIdentity } from '../platform/identity.ts'
import type { ProcessWatchdog, ReapResult } from '../platform/process-types.ts'
import { reapProcessTree } from '../platform/process-tree.ts'
import { makeProcessRegistrar } from './process-registrar.ts'

const state = vi.hoisted(() => ({
  group: 12345,
  registered: new Map<number, ProcessIdentity>(),
  unregisterFails: false,
}))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async () => ({ stdout: `${state.group}\n`, stderr: '' }),
    }),
  }
})
vi.mock('../platform/identity.ts', () => ({
  readProcessIdentity: async (pid: number) => ({ pid, creationTime: 'original' }),
}))
vi.mock('../platform/process-tree.ts', () => ({ reapProcessTree: vi.fn() }))
vi.mock('../platform/watchdog.ts', () => ({
  startProcessWatchdog: async (): Promise<ProcessWatchdog> => ({
    pid: 23456,
    register: async (identity) => {
      state.registered.set(identity.pid, identity)
    },
    unregister: async (identity) => {
      if (state.unregisterFails) throw new Error('watchdog acknowledgement failed')
      state.registered.delete(identity.pid)
    },
    close: async () => {},
  }),
}))

beforeEach(() => {
  state.registered.clear()
  state.unregisterFails = false
  vi.resetAllMocks()
})

describe.skipIf(process.platform === 'win32')('Agent host process registrations', () => {
  it.each(['timeout', 'throw'] as const)('retains watchdog ownership after reaping %s', async (failure) => {
    const registrar = Effect.runSync(makeProcessRegistrar())
    expect(await Effect.runPromise(registrar.register(state.group))).toBe(true)
    const identity = { pid: state.group, creationTime: 'original' }
    expect([...state.registered.values()]).toEqual([identity])
    if (failure === 'timeout') vi.mocked(reapProcessTree).mockResolvedValue({ reaped: false, reason: 'timeout' })
    else vi.mocked(reapProcessTree).mockRejectedValue(new Error('process inspection failed'))

    const released = await Effect.runPromiseExit(registrar.release(state.group))
    expect([...state.registered.values()]).toEqual([identity])
    expect(Exit.isFailure(released)).toBe(true)

    vi.mocked(reapProcessTree).mockResolvedValue({ reaped: true })
    await Effect.runPromise(registrar.release(state.group))
    expect([...state.registered.values()]).toEqual([])
    await Effect.runPromise(registrar.close)
  })

  it.each([{ reaped: true }, { reaped: false, reason: 'identity-mismatch' }] satisfies ReapResult[])(
    'unregisters only after a safe reaping result: %j',
    async (result) => {
      const registrar = Effect.runSync(makeProcessRegistrar())
      await Effect.runPromise(registrar.register(state.group))
      vi.mocked(reapProcessTree).mockResolvedValue(result)
      await Effect.runPromise(registrar.release(state.group))
      expect([...state.registered.values()]).toEqual([])
      await Effect.runPromise(registrar.close)
    },
  )

  it('keeps the local registration available to retry a failed watchdog removal', async () => {
    const registrar = Effect.runSync(makeProcessRegistrar())
    await Effect.runPromise(registrar.register(state.group))
    vi.mocked(reapProcessTree).mockResolvedValue({ reaped: true })
    state.unregisterFails = true
    const released = await Effect.runPromiseExit(registrar.release(state.group))
    expect([...state.registered.values()]).toEqual([{ pid: state.group, creationTime: 'original' }])
    expect(Exit.isFailure(released)).toBe(true)
    state.unregisterFails = false
    await Effect.runPromise(registrar.release(state.group))
    expect([...state.registered.values()]).toEqual([])
    await Effect.runPromise(registrar.close)
  })
})
