import childProcess, { spawn as esmSpawn, fork as esmFork } from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { installHostProcessGroup } from './host-process-group.ts'

const fixture = fileURLToPath(new URL('../testing/platform/fork-child.mjs', import.meta.url))

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

describe.skipIf(process.platform === 'win32')('exclusive host process group', () => {
  it('keeps spawn/fork children in the parent group and preserves SDK environment and fd3/4', async () => {
    const group = childProcess
      .execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' })
      .trim()
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(String(process.pid))
    const { restore } = installHostProcessGroup()
    try {
      expect(childProcess.spawn).toBe(esmSpawn)
      expect(childProcess.fork).toBe(esmFork)
      const child = esmSpawn(
        process.execPath,
        [
          '-e',
          "const fs = require('node:fs'); fs.writeSync(3, process.env.GROUP_FIXTURE_VALUE); fs.writeSync(4, require('node:child_process').execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid=']))",
        ],
        Object.freeze({
          detached: true,
          env: { ...process.env, GROUP_FIXTURE_VALUE: 'from-parent' },
          stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] as childProcess.StdioOptions,
        }),
      )
      const output = ['', '']
      child.stdio[3]?.on('data', (chunk) => {
        output[0] += String(chunk)
      })
      child.stdio[4]?.on('data', (chunk) => {
        output[1] += String(chunk)
      })
      await once(child, 'close')
      expect(output[0]).toBe('from-parent')
      expect(output[1].trim()).toBe(group)
      const forked = esmFork(fixture, [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      const [[message]] = await Promise.all([once(forked, 'message'), once(forked, 'exit')])
      expect(message).toEqual({ group })
    } finally {
      restore()
    }
  })
})
