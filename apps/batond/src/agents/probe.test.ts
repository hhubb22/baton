import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Schema, Stream } from 'effect'
import { DEFAULT_MODEL } from '@t3tools/contracts'
import { RuntimeAgent } from '@baton/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ProbeResult } from '../agent-host/protocol.ts'
import type { AgentHostConnection, AgentHostProcessOptions } from '../agent-host/transport.ts'
import { readPrivateFile, validatePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import type { ProcessRecordCallbacks } from '../platform/process-types.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { AgentError } from '../worker/agent.ts'
import { agentCatalog, type HostedAgentType } from './catalog.ts'
import { probeAgents, probeInternals } from './probe.ts'

const directories: string[] = []
const providers = ['cursor', 'pi', 'codex', 'kiro'] as const
const result: ProbeResult = { authenticated: 'unknown', models: [], details: { installed: true } }
const record = { pid: 12345, creationTime: 'probe-fixture-created', role: 'kiro-host' }
const deferred = <A = void>() => Promise.withResolvers<A>()
const root = async () => {
  const directory = await makePrivateTempDirectory('baton-probe-records-')
  directories.push(directory)
  return directory
}
const host = (probe: AgentHostConnection['probe'] = Effect.succeed(result)): AgentHostConnection => ({
  probe,
  open: () => Effect.die('Probe must not open a session'),
  resume: () => Effect.die('Probe must not resume a session'),
  send: () => Effect.die('Probe must not send a prompt'),
  sent: () => Effect.die('Probe must not inspect a submission'),
  events: Stream.empty,
  flushEvents: () => Effect.die('Probe must not flush session events'),
  abort: Effect.die('Probe must not call session abort'),
  close: Effect.die('Probe must not close a session'),
  exited: Effect.never,
  disconnect: Effect.void,
  reap: Effect.succeed({ processTreeStopped: true }),
})
const probe = async (agentType: HostedAgentType, value: ProbeResult) => {
  vi.mocked(probeInternals.connect).mockReturnValue(Effect.succeed(host(Effect.succeed(value))))
  const [report] = await probeAgents({ dataDirectory: await root(), agentTypes: [agentType] })
  return report!
}

beforeEach(() => {
  vi.stubEnv('CURSOR_API_KEY', 'offline-test-key')
  vi.spyOn(probeInternals, 'inspectCursorSdk').mockReturnValue({
    version: '9.0.0',
    nodeRange: undefined,
    entryPath: '',
    packageRoot: '',
    platformPackageName: '',
    platformVersion: '9.0.0',
    platformRoot: '',
    sandboxHelper: '',
    rg: '',
    treeSitter: '',
    treeSitterBash: '',
    missingAssets: [],
  })
  vi.spyOn(probeInternals, 'platform').mockReturnValue('linux')
  vi.spyOn(probeInternals, 'startProcessWatchdog').mockResolvedValue({
    pid: 123,
    register: async () => {},
    unregister: async () => {},
    close: async () => {},
  })
  vi.spyOn(probeInternals, 'reapProcessTree').mockResolvedValue({ reaped: true })
  vi.spyOn(probeInternals, 'connect').mockReturnValue(Effect.succeed(host()))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('probe selection', () => {
  it('starts the catalog hosted agents concurrently and preserves default report order', async () => {
    const started: string[] = []
    const allStarted = deferred()
    const release = deferred()
    vi.mocked(probeInternals.connect).mockImplementation((options) =>
      Effect.sync(() =>
        host(
          Effect.promise(async () => {
            started.push(options.agentType)
            if (started.length === providers.length) allStarted.resolve()
            await release.promise
            return result
          }),
        ),
      ),
    )
    const pending = probeAgents({ dataDirectory: await root() })
    await allStarted.promise
    expect(new Set(started)).toEqual(new Set(providers))
    release.resolve()
    expect((await pending).map((report) => report.agent_type)).toEqual(providers)
  })

  it('deduplicates requested types in request order and accepts an empty selection', async () => {
    const dataDirectory = await root()
    const reports = await probeAgents({ dataDirectory, agentTypes: ['kiro', 'cursor', 'kiro', 'pi'] })
    expect(reports.map((report) => report.agent_type)).toEqual(['kiro', 'cursor', 'pi'])
    expect(probeInternals.connect).toHaveBeenCalledTimes(3)
    expect(await probeAgents({ dataDirectory, agentTypes: [] })).toEqual([])
    expect(probeInternals.connect).toHaveBeenCalledTimes(3)
  })

  it.each(['shell', 'unknown', '__proto__'])('rejects %s before starting any probe', async (invalid) => {
    await expect(
      probeAgents({ dataDirectory: await root(), agentTypes: ['pi', invalid as HostedAgentType] }),
    ).rejects.toThrow('Unknown hosted Agent type')
    expect(probeInternals.connect).not.toHaveBeenCalled()
    expect(probeInternals.startProcessWatchdog).not.toHaveBeenCalled()
    expect(probeInternals.inspectCursorSdk).not.toHaveBeenCalled()
  })
})

describe.each(providers)('%s report', (agentType) => {
  it.each([
    { version: 'unknown', platform: 'linux-x64', authenticated: 'unknown' },
    { version: '9.0.0-preview.1+build.7', platform: 'win32-arm64', authenticated: 'valid' },
    { version: '9.0.0', platform: 'darwin-x64', authenticated: 'unknown' },
  ] satisfies Array<{ version: string; platform: string; authenticated: ProbeResult['authenticated'] }>)(
    'allows $version / $platform with $authenticated authentication',
    async ({ version, platform, authenticated }) => {
      const report = await probe(agentType, {
        authenticated,
        models: ['example', 'example', 'second'],
        details: { installed: true, version, platform },
      })
      expect(report).toMatchObject({
        status: 'available',
        version,
        models: [
          { id: 'example', name: 'example' },
          { id: 'second', name: 'second' },
        ],
        default_model: agentType === 'cursor' ? 'default' : 'example',
        capabilities: agentCatalog[agentType].capabilities,
      })
      expect(report.reason).toContain(`${version} / ${platform}`)
      if (authenticated === 'unknown') expect(report.reason).toContain('认证状态未知')
      expect(Schema.is(RuntimeAgent)(report)).toBe(true)
    },
  )

  it.each([
    { installed: false, authenticated: 'unknown', reason: '程序未安装' },
    { installed: true, authenticated: 'missing', reason: '尚未认证' },
  ] satisfies Array<{ installed: boolean; authenticated: ProbeResult['authenticated']; reason: string }>)(
    'reports $reason as unavailable',
    async ({ installed, authenticated, reason }) => {
      expect(await probe(agentType, { authenticated, models: [], details: { installed }, reason })).toMatchObject({
        status: 'unavailable',
        reason,
        default_model: '',
        capabilities: { create: false, resume: false },
      })
    },
  )

  it('keeps version timeouts diagnostic and supplies the native default model', async () => {
    const report = await probe(agentType, {
      authenticated: 'unknown',
      models: [],
      details: { installed: true, version: 'unknown' },
      reason: '版本探测超时',
    })
    expect(report).toMatchObject({
      status: 'available',
      default_model: agentType === 'codex' ? DEFAULT_MODEL : 'default',
      capabilities: agentCatalog[agentType].capabilities,
    })
    expect(report.reason).toContain('版本探测超时')
    expect(report.reason).toContain('模型目录暂不可读')
    if (agentType === 'kiro' || agentType === 'cursor') expect(report.reason).toContain('上游 adapter 不支持 steer')
  })

  it('reports unconfirmed installation as unverified', async () => {
    const report = await probe(agentType, {
      authenticated: 'unknown',
      models: [],
      details: {},
      reason: '只读探测失败',
    })
    expect(report).toMatchObject({ status: 'unverified', capabilities: { create: false, resume: false } })
    expect(report.reason).toContain('安装状态尚未确认')
  })
})

it.each(['codex', 'pi'] as const)('reports %s thinking choices with their model', async (agentType) => {
  const thinking = {
    id: agentType === 'codex' ? ('reasoningEffort' as const) : ('thinking' as const),
    options: [{ id: 'high', label: 'High', is_default: true }],
  }
  const report = await probe(agentType, {
    authenticated: 'valid',
    models: ['model-a', 'model-b'],
    model_thinking: [{ model: 'model-a', thinking }],
    details: { installed: true },
  })
  expect(report.models).toEqual([
    { id: 'model-a', name: 'model-a', thinking },
    { id: 'model-b', name: 'model-b' },
  ])
  expect(Schema.is(RuntimeAgent)(report)).toBe(true)
})

describe('Cursor installation', () => {
  it.each([{ integrity: false }, { sandboxHelper: false }])('reports dependency failures: %j', async (details) => {
    expect(
      await probe('cursor', {
        authenticated: 'unknown',
        models: [],
        details: { installed: true, ...details },
        reason: '本机依赖不可用',
      }),
    ).toMatchObject({ status: 'unavailable', reason: '本机依赖不可用', capabilities: { create: false } })
  })

  it.each(['missing', 'assets', 'version'])('rejects an incomplete SDK (%s) before host startup', async (failure) => {
    const inspection = probeInternals.inspectCursorSdk()
    if (failure === 'missing')
      vi.mocked(probeInternals.inspectCursorSdk).mockImplementation(() => {
        throw new Error('Missing SDK')
      })
    else
      vi.mocked(probeInternals.inspectCursorSdk).mockReturnValue({
        ...inspection,
        ...(failure === 'assets' ? { missingAssets: ['binding.node'] } : { platformVersion: '0.0.0' }),
      })
    const [report] = await probeAgents({ dataDirectory: await root(), agentTypes: ['cursor'] })
    expect(report).toMatchObject({ status: 'unavailable', capabilities: { create: false, resume: false } })
    expect(report?.reason).toContain('Cursor SDK 安装不完整')
    expect(probeInternals.connect).not.toHaveBeenCalled()
    expect(probeInternals.startProcessWatchdog).not.toHaveBeenCalled()
  })

  it('requires an explicit API key before host startup', async () => {
    vi.stubEnv('CURSOR_API_KEY', '  ')
    expect(await probeAgents({ dataDirectory: await root(), agentTypes: ['cursor'] })).toMatchObject([
      { status: 'unavailable', reason: '需要显式配置 CURSOR_API_KEY' },
    ])
    expect(probeInternals.connect).not.toHaveBeenCalled()
  })

  it('uses installed SDK metadata as fallback when the host fails', async () => {
    vi.mocked(probeInternals.connect).mockReturnValue(Effect.fail(new AgentError('offline probe failure')))
    const [report] = await probeAgents({ dataDirectory: await root(), agentTypes: ['cursor'] })
    expect(report).toMatchObject({
      status: 'available',
      version: '9.0.0',
      capabilities: { create: true, resume: true },
    })
    expect(report?.reason).toContain('只读探测失败或超时')
  })
})

describe('probe lifecycle', () => {
  it.each(['success', 'failure', 'timeout', 'cancel'] as const)(
    'removes the private workspace after ordered cleanup on %s',
    async (outcome) => {
      if (outcome === 'timeout') vi.useFakeTimers()
      const started = deferred()
      const disconnecting = deferred()
      const release = deferred()
      const events: string[] = []
      let paths: AgentHostProcessOptions['paths'] | undefined
      vi.mocked(probeInternals.startProcessWatchdog).mockResolvedValue({
        pid: 123,
        register: async () => {},
        unregister: async () => {},
        close: async () => {
          await expect(access(paths!.privateDirectory)).rejects.toThrow()
          events.push('watchdog-close')
        },
      })
      vi.mocked(probeInternals.connect).mockImplementation((options, signal) =>
        Effect.promise(async () => {
          paths = options.paths
          expect(paths.privateDirectory).toBe(paths.workingDirectory)
          await validatePrivateDirectory(paths.privateDirectory)
          expect(options.watchdog).toBeDefined()
          expect(options.records).toBeUndefined()
          signal.addEventListener('abort', () => events.push('abort'), { once: true })
          return {
            ...host(
              Effect.sync(() => started.resolve()).pipe(
                Effect.andThen(
                  outcome === 'success'
                    ? Effect.succeed(result)
                    : outcome === 'failure'
                      ? Effect.fail(new AgentError('probe failed'))
                      : Effect.never,
                ),
              ),
            ),
            disconnect: Effect.promise(async () => {
              events.push('disconnect')
              disconnecting.resolve()
              if (outcome === 'cancel') await release.promise
            }),
            reap: Effect.sync(() => {
              events.push('reap')
              return { processTreeStopped: true }
            }),
          }
        }),
      )
      const controller = new AbortController()
      let settled = false
      const pending = probeAgents({ dataDirectory: await root(), agentTypes: ['pi'], signal: controller.signal }).then(
        (reports) => {
          settled = true
          return { reports }
        },
        (error: unknown) => {
          settled = true
          return { error }
        },
      )
      await started.promise
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(30_000)
      if (outcome === 'cancel') {
        controller.abort()
        await disconnecting.promise
        expect(settled).toBe(false)
        await access(paths!.privateDirectory)
        release.resolve()
      }
      const value = await pending
      if (outcome === 'cancel') expect(value).toHaveProperty('error')
      else {
        expect(value).toHaveProperty('reports.0.status', outcome === 'success' ? 'available' : 'unverified')
      }
      expect(events).toEqual(['abort', 'disconnect', 'reap', 'watchdog-close'])
      await expect(access(paths!.privateDirectory)).rejects.toThrow()
    },
  )

  it('waits for interrupted connection startup cleanup before rejecting', async () => {
    const started = deferred()
    const cleaning = deferred()
    const release = deferred()
    let paths: AgentHostProcessOptions['paths'] | undefined
    vi.mocked(probeInternals.connect).mockImplementation((options) => {
      paths = options.paths
      return Effect.callback(() => {
        started.resolve()
        return Effect.promise(async () => {
          cleaning.resolve()
          await release.promise
        })
      })
    })
    const controller = new AbortController()
    let settled = false
    const pending = probeAgents({ dataDirectory: await root(), agentTypes: ['pi'], signal: controller.signal }).then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await started.promise
    controller.abort()
    await cleaning.promise
    expect(settled).toBe(false)
    await access(paths!.privateDirectory)
    release.resolve()
    expect(await pending).toBeInstanceOf(Error)
    await expect(access(paths!.privateDirectory)).rejects.toThrow()
  })

  it('waits for every concurrent probe to finish cleanup on cancellation', async () => {
    const started = deferred()
    const cleaning = deferred()
    const release = deferred()
    const paths: string[] = []
    let disconnecting = 0
    let reaped = 0
    vi.mocked(probeInternals.connect).mockImplementation((options) =>
      Effect.sync(() => {
        paths.push(options.paths.privateDirectory)
        return {
          ...host(
            Effect.sync(() => {
              if (paths.length === providers.length) started.resolve()
            }).pipe(Effect.andThen(Effect.never)),
          ),
          disconnect: Effect.promise(async () => {
            if (++disconnecting === providers.length) cleaning.resolve()
            await release.promise
          }),
          reap: Effect.sync(() => {
            reaped++
            return { processTreeStopped: true }
          }),
        }
      }),
    )
    const controller = new AbortController()
    let settled = false
    const pending = probeAgents({ dataDirectory: await root(), signal: controller.signal }).then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await started.promise
    controller.abort()
    await cleaning.promise
    expect(settled).toBe(false)
    release.resolve()
    expect(await pending).toBeInstanceOf(Error)
    expect(reaped).toBe(providers.length)
    for (const path of paths) await expect(access(path)).rejects.toThrow()
  })

  it('rejects an already canceled batch before any startup', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(probeAgents({ dataDirectory: await root(), signal: controller.signal })).rejects.toThrow()
    expect(probeInternals.connect).not.toHaveBeenCalled()
    expect(probeInternals.startProcessWatchdog).not.toHaveBeenCalled()
  })
})

describe('Windows probe ownership', () => {
  beforeEach(() => {
    vi.mocked(probeInternals.platform).mockReturnValue('win32')
  })

  it.each(['reaped', 'identity-mismatch'] as const)(
    'retains failed cleanup records and recovers them before startup (%s)',
    async (recovery) => {
      const dataDirectory = await root()
      const file = join(dataDirectory, 'agent-probes', 'kiro', 'processes.json')
      const lock = join(dataDirectory, 'agent-probes', 'kiro', 'probe.lock')
      vi.mocked(probeInternals.reapProcessTree).mockResolvedValue({ reaped: false, reason: 'timeout' })
      vi.mocked(probeInternals.connect).mockImplementationOnce((options) =>
        Effect.promise(async () => {
          expect(options.watchdog).toBeUndefined()
          await options.records!.add(record)
          expect(JSON.parse((await readPrivateFile(file)).toString('utf8'))).toEqual([record])
          return { ...host(), reap: Effect.succeed({ processTreeStopped: false }) }
        }),
      )
      expect(await probeAgents({ dataDirectory, agentTypes: ['kiro'] })).toMatchObject([{ status: 'unverified' }])
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([record])
      await expect(access(lock)).rejects.toThrow()
      vi.mocked(probeInternals.reapProcessTree).mockResolvedValue(
        recovery === 'reaped' ? { reaped: true } : { reaped: false, reason: 'identity-mismatch' },
      )
      vi.mocked(probeInternals.connect).mockImplementationOnce(() =>
        Effect.promise(async () => {
          expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
          return host()
        }),
      )
      expect(await probeAgents({ dataDirectory, agentTypes: ['kiro'] })).toMatchObject([{ status: 'available' }])
      expect(probeInternals.reapProcessTree).toHaveBeenCalledWith(record)
      expect(probeInternals.startProcessWatchdog).not.toHaveBeenCalled()
    },
  )

  it('keeps the lock through cleanup and refuses conflicting identities without removing the owner', async () => {
    const dataDirectory = await root()
    const file = join(dataDirectory, 'agent-probes', 'pi', 'processes.json')
    const started = deferred<ProcessRecordCallbacks>()
    const disconnecting = deferred()
    const release = deferred()
    vi.mocked(probeInternals.connect).mockImplementation((options) =>
      Effect.promise(async () => {
        const records = options.records!
        await records.add(record)
        return {
          ...host(Effect.sync(() => started.resolve(records)).pipe(Effect.andThen(Effect.never))),
          disconnect: Effect.promise(async () => {
            disconnecting.resolve()
            await release.promise
          }),
        }
      }),
    )
    const controller = new AbortController()
    const pending = probeAgents({ dataDirectory, agentTypes: ['pi'], signal: controller.signal }).catch(
      (error: unknown) => error,
    )
    const records = await started.promise
    await expect(records.add({ ...record, creationTime: 'reused-pid' })).rejects.toThrow('identity conflict')
    await records.remove({ ...record, creationTime: 'reused-pid' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([record])
    expect(await probeAgents({ dataDirectory, agentTypes: ['pi'] })).toMatchObject([{ status: 'unverified' }])
    controller.abort()
    await disconnecting.promise
    expect(await probeAgents({ dataDirectory, agentTypes: ['pi'] })).toMatchObject([{ status: 'unverified' }])
    expect(probeInternals.connect).toHaveBeenCalledTimes(1)
    expect(probeInternals.reapProcessTree).not.toHaveBeenCalled()
    release.resolve()
    expect(await pending).toBeInstanceOf(Error)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
    vi.mocked(probeInternals.connect).mockReturnValue(Effect.succeed(host()))
    expect(await probeAgents({ dataDirectory, agentTypes: ['pi'] })).toMatchObject([{ status: 'available' }])
  })

  it('retains ownership until an interrupted recovery finishes', async () => {
    const dataDirectory = await root()
    const file = join(dataDirectory, 'agent-probes', 'kiro', 'processes.json')
    await probeAgents({ dataDirectory, agentTypes: ['kiro'] })
    await writePrivateFileAtomic(file, JSON.stringify([record]))
    const recovering = deferred()
    const release = deferred()
    vi.mocked(probeInternals.reapProcessTree).mockImplementation(async () => {
      recovering.resolve()
      await release.promise
      return { reaped: true }
    })
    vi.mocked(probeInternals.connect).mockClear()
    const controller = new AbortController()
    let settled = false
    const pending = probeAgents({ dataDirectory, agentTypes: ['kiro'], signal: controller.signal }).then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await recovering.promise
    controller.abort()
    expect(await probeAgents({ dataDirectory, agentTypes: ['kiro'] })).toMatchObject([{ status: 'unverified' }])
    expect(settled).toBe(false)
    expect(probeInternals.reapProcessTree).toHaveBeenCalledTimes(1)
    expect(probeInternals.connect).not.toHaveBeenCalled()
    release.resolve()
    expect(await pending).toBeInstanceOf(Error)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
    expect(await probeAgents({ dataDirectory, agentTypes: ['kiro'] })).toMatchObject([{ status: 'available' }])
  })

  it('refuses corrupt durable state before launching a host', async () => {
    const dataDirectory = await root()
    await probeAgents({ dataDirectory, agentTypes: ['codex'] })
    const file = join(dataDirectory, 'agent-probes', 'codex', 'processes.json')
    await writePrivateFileAtomic(file, '[{"pid":1}]')
    vi.mocked(probeInternals.connect).mockClear()
    expect(await probeAgents({ dataDirectory, agentTypes: ['codex'] })).toMatchObject([{ status: 'unverified' }])
    expect(probeInternals.connect).not.toHaveBeenCalled()
    expect(probeInternals.reapProcessTree).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('[{"pid":1}]')
  })
})
