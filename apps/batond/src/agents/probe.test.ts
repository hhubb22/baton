import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Exit, Scope, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { AgentHostConnection, AgentHostProcessOptions } from '../agent-host/transport.ts'
import { connectAgentHost } from '../agent-host/transport.ts'
import { readPrivateFile, validatePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeProbeProcessRecords, probeHost } from './registry.ts'
import { probeCursor } from './cursor/probe.ts'
import { probePi } from './pi/probe.ts'
import { probeCodex } from './codex/probe.ts'
import { probeKiro } from './kiro/probe.ts'

vi.mock('../agent-host/transport.ts', () => ({ connectAgentHost: vi.fn() }))

const directories: string[] = []
const scopes: Scope.Closeable[] = []
const run = Effect.runPromise
const record = { pid: 12345, creationTime: 'probe-fixture-created', role: 'kiro-host' }
const result = { authenticated: 'unknown' as const, models: [], details: { installed: true } }
const root = async () => {
  const directory = await makePrivateTempDirectory('baton-probe-records-')
  directories.push(directory)
  return directory
}
const scopedRecords = async (directory: string, reap: Parameters<typeof makeProbeProcessRecords>[1]) => {
  const scope = await run(Scope.make())
  scopes.push(scope)
  const records = await run(makeProbeProcessRecords(directory, reap).pipe(Effect.provideService(Scope.Scope, scope)))
  return { records, close: () => run(Scope.close(scope, Exit.void)) }
}

afterEach(async () => {
  for (const scope of scopes.splice(0)) await run(Scope.close(scope, Exit.void))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.resetAllMocks()
})

describe('probe process ownership', () => {
  it('fails scope cleanup while retaining the record for recovery before the next probe', async () => {
    const directory = join(await root(), 'kiro')
    const first = await scopedRecords(directory, async () => ({ reaped: false, reason: 'timeout' }))
    await first.records.add(record)
    expect(JSON.parse((await readPrivateFile(join(directory, 'processes.json'))).toString('utf8'))).toEqual([record])
    await expect(first.close()).rejects.toThrow()
    expect(JSON.parse(await readFile(join(directory, 'processes.json'), 'utf8'))).toEqual([record])
    const recovered: unknown[] = []
    const second = await scopedRecords(directory, async (identity) => {
      recovered.push(identity)
      return { reaped: true }
    })
    expect(recovered).toEqual([record])
    expect(JSON.parse(await readFile(join(directory, 'processes.json'), 'utf8'))).toEqual([])
    await second.close()
  })

  it('keeps an active probe locked and refuses a conflicting process identity', async () => {
    const directory = join(await root(), 'pi')
    const first = await scopedRecords(directory, async () => ({ reaped: true }))
    await first.records.add(record)
    await expect(first.records.add({ ...record, creationTime: 'reused-pid' })).rejects.toThrow('identity conflict')
    await first.records.remove({ ...record, creationTime: 'reused-pid' })
    const unexpectedReap = vi.fn(async () => ({ reaped: true }))
    await expect(scopedRecords(directory, unexpectedReap)).rejects.toThrow('Process lock is held')
    expect(unexpectedReap).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(directory, 'processes.json'), 'utf8'))).toEqual([record])
    await first.close()
  })

  it('refuses corrupt durable state before launching a new probe', async () => {
    const directory = join(await root(), 'codex')
    const first = await scopedRecords(directory, async () => ({ reaped: true }))
    await first.close()
    await writePrivateFileAtomic(join(directory, 'processes.json'), '[{"pid":1}]')
    await expect(scopedRecords(directory, async () => ({ reaped: true }))).rejects.toThrow()
    expect(await readFile(join(directory, 'processes.json'), 'utf8')).toBe('[{"pid":1}]')
  })

  it('uses durable callbacks without a POSIX watchdog for Windows probes', async () => {
    const dataDirectory = await root()
    const value = await probeHost(
      'kiro',
      (options) =>
        Effect.promise(async () => {
          expect(options.watchdog).toBeUndefined()
          expect(options.records).toBeDefined()
          await options.records!.add(record)
          const file = join(dataDirectory, 'agent-probes', 'kiro', 'processes.json')
          expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([record])
          await options.records!.remove(record)
          expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
          return result
        }),
      { dataDirectory, platform: 'win32' },
    )
    expect(value).toEqual(result)
  })
})

it.each([
  ['cursor', probeCursor],
  ['pi', probePi],
  ['codex', probeCodex],
  ['kiro', probeKiro],
] as const)('protects and removes the %s probe workspace', async (agentType, probe) => {
  let paths: AgentHostProcessOptions['paths'] | undefined
  vi.mocked(connectAgentHost).mockImplementation((options) =>
    Effect.promise(async () => {
      paths = options.paths
      expect(options.agentType).toBe(agentType)
      expect(paths.privateDirectory).toBe(paths.workingDirectory)
      await validatePrivateDirectory(paths.privateDirectory)
      return {
        probe: Effect.succeed(result),
        open: () => Effect.die('Probe must not open a session'),
        resume: () => Effect.die('Probe must not resume a session'),
        send: () => Effect.die('Probe must not send a prompt'),
        sent: () => Effect.die('Probe must not inspect a submission'),
        events: Stream.empty,
        abort: Effect.void,
        close: Effect.void,
        exited: Effect.never,
        disconnect: Effect.void,
        reap: Effect.succeed({ processTreeStopped: true }),
      } satisfies AgentHostConnection
    }),
  )
  expect(await run(probe({ command: { file: process.execPath } }))).toEqual(result)
  expect(paths).toBeDefined()
  await expect(access(paths!.privateDirectory)).rejects.toThrow()
})
