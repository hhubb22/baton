import childProcess, { spawn as esmSpawn, fork as esmFork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installHostProcessGroup } from './host-process-group.ts'

const fixture = fileURLToPath(new URL('./test-fixtures/fork-child.mjs', import.meta.url))

afterEach(() => vi.restoreAllMocks())

describe.skipIf(process.platform === 'win32')('exclusive host process group', () => {
  it('refuses a shared group before changing builtins', () => {
    const originalSpawn = childProcess.spawn
    const originalFork = childProcess.fork
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(String(process.pid + 1))
    expect(() => installHostProcessGroup()).toThrow('Host must lead its own exclusive process group')
    expect(childProcess.spawn).toBe(originalSpawn)
    expect(childProcess.fork).toBe(originalFork)
  })
  it('preserves spawn/fork overloads and options while disabling detachment in CJS and ESM', async () => {
    const originalSpawn = childProcess.spawn
    const originalFork = childProcess.fork
    const calls: unknown[][] = []
    const record = <F extends typeof originalSpawn | typeof originalFork>(original: F): F =>
      new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          calls.push(args)
          return Reflect.apply(target, receiver, args)
        },
      })
    childProcess.spawn = record(originalSpawn)
    childProcess.fork = record(originalFork)
    const recordedSpawn = childProcess.spawn
    const recordedFork = childProcess.fork
    syncBuiltinESMExports()
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(String(process.pid))
    const { restore } = installHostProcessGroup()
    try {
      const cjs: typeof childProcess = createRequire(import.meta.url)('node:child_process')
      expect(cjs.spawn).toBe(esmSpawn)
      expect(cjs.fork).toBe(esmFork)
      const controller = new AbortController()
      const options = Object.freeze({
        detached: true,
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: 'ignore' as const,
        signal: controller.signal,
        windowsHide: true,
      })
      await once(esmSpawn(process.execPath, ['-e', ''], options), 'exit')
      await once(cjs.spawn(process.execPath, options), 'exit')
      const stdio: childProcess.StdioOptions = ['ignore', 'ignore', 'ignore', 'ipc']
      const forkOptions = Object.freeze({ ...options, stdio })
      await once(esmFork(fixture, [], forkOptions), 'exit')
      await once(cjs.fork(fixture, forkOptions), 'exit')
      for (const [index, call] of calls.entries()) {
        const source = index < 2 ? options : forkOptions
        expect(call[Array.isArray(call[1]) ? 2 : 1]).toEqual({ ...source, detached: false })
        const passed = call[Array.isArray(call[1]) ? 2 : 1]
        expect(passed).not.toBe(source)
        expect(Reflect.get(passed as object, 'stdio')).toBe(source.stdio)
        expect(Reflect.get(passed as object, 'env')).toBe(source.env)
        expect(Reflect.get(passed as object, 'signal')).toBe(source.signal)
      }
      await once(Reflect.apply(esmSpawn, childProcess, [process.execPath, undefined, options]), 'exit')
      expect(calls.at(-1)?.[2]).toEqual({ ...options, detached: false })
      await once(esmFork(fixture, undefined, forkOptions), 'exit')
      expect(calls.at(-1)?.[2]).toEqual({ ...forkOptions, detached: false })
      const extraStdio: childProcess.StdioOptions = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
      const fdOptions = Object.freeze({ ...options, stdio: extraStdio })
      const fdChild = esmSpawn(
        process.execPath,
        ['-e', "require('node:fs').writeSync(3, 'fd3'); require('node:fs').writeSync(4, 'fd4')"],
        fdOptions,
      )
      const fdOutput = ['', '']
      fdChild.stdio[3]?.on('data', (chunk) => {
        fdOutput[0] += String(chunk)
      })
      fdChild.stdio[4]?.on('data', (chunk) => {
        fdOutput[1] += String(chunk)
      })
      await once(fdChild, 'close')
      expect(fdOutput).toEqual(['fd3', 'fd4'])
      expect(Reflect.get(calls.at(-1)?.[2] as object, 'stdio')).toBe(extraStdio)
      const normalOptions = Object.freeze({ ...options, detached: false })
      await once(esmSpawn(process.execPath, ['-e', ''], normalOptions), 'exit')
      expect(calls.at(-1)?.[2]).toBe(normalOptions)
      await once(esmSpawn(process.execPath, ['-e', '']), 'exit')
      expect(calls.at(-1)).toEqual([process.execPath, ['-e', '']])
      expect(options.detached).toBe(true)
      expect(forkOptions.detached).toBe(true)
      expect(() => installHostProcessGroup()).toThrow('already installed')
      restore()
      restore()
      expect(esmSpawn).toBe(recordedSpawn)
      expect(esmFork).toBe(recordedFork)
    } finally {
      restore()
      childProcess.spawn = originalSpawn
      childProcess.fork = originalFork
      syncBuiltinESMExports()
    }
  })
})
