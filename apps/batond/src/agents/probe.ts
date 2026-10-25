import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cause, Effect, Schema } from 'effect'
import { DEFAULT_MODEL } from '@t3tools/contracts'
import type { RuntimeAgent } from '@baton/protocol'
import type { ProbeResult } from '../agent-host/protocol.ts'
import { connectAgentHost, type AgentHostProcessOptions } from '../agent-host/transport.ts'
import { currentBatondCommand } from '../daemon/host.ts'
import { hasCode } from '../platform/errors.ts'
import { acquireProcessLockScoped } from '../platform/lock.ts'
import {
  ensurePrivateDirectory,
  protectPrivateDirectory,
  readPrivateFile,
  writePrivateFileAtomic,
} from '../platform/private.ts'
import { reapProcessTree, startProcessWatchdog } from '../platform/process.ts'
import type { ProcessRecord, ProcessRecordCallbacks } from '../platform/process-types.ts'
import { AgentError } from '../worker/agent.ts'
import { agentCatalog, type HostedAgentType } from './catalog.ts'
import { inspectCursorSdk } from './cursor/sdk-inspection.ts'

/** @internal 进程和安装检查的依赖边界。 */
export const probeInternals = {
  connect: connectAgentHost,
  inspectCursorSdk,
  startProcessWatchdog,
  reapProcessTree,
  platform: (): NodeJS.Platform => process.platform,
}

const narrowed = { create: false, queue: true, steer: false, stop: true, resume: false, switch_model: false }

function hostedAgentReport(agentType: HostedAgentType, result: ProbeResult): RuntimeAgent {
  const entry = agentCatalog[agentType]
  const missingReason = `${entry.name} ${agentType === 'cursor' ? 'SDK' : 'CLI'} 未安装或尚未认证`
  const version = typeof result.details.version === 'string' ? result.details.version : 'unknown'
  const platform =
    typeof result.details.platform === 'string' ? result.details.platform : `${process.platform}-${process.arch}`
  const models = [...new Set(result.models)].map((id) => ({ id, name: id }))
  const base: RuntimeAgent = {
    agent_type: agentType,
    version,
    status: 'unverified',
    models,
    default_model: '',
    capabilities: narrowed,
  }
  if (result.details.installed === false || result.authenticated === 'missing')
    return { ...base, status: 'unavailable', reason: result.reason ?? missingReason }
  if (agentType === 'cursor' && (result.details.integrity === false || result.details.sandboxHelper === false))
    return { ...base, status: 'unavailable', reason: result.reason ?? 'Cursor SDK 安装或本机 sandbox 不可用' }
  const reason = [
    result.reason,
    `${agentType} ${version} / ${platform}`,
    ...(result.authenticated === 'unknown' ? ['认证状态未知，首次执行时由原生程序检查'] : []),
    ...(models.length === 0 ? ['模型目录暂不可读，可使用默认模型'] : []),
    entry.limitation,
  ]
    .filter(Boolean)
    .join('；')
  if (result.details.installed !== true) return { ...base, reason: `${reason}；安装状态尚未确认` }
  return {
    ...base,
    status: 'available',
    default_model:
      agentType === 'cursor' ? 'default' : models[0]?.id || (agentType === 'codex' ? DEFAULT_MODEL : 'default'),
    capabilities: entry.capabilities,
    reason,
  }
}

const ProbeRecord = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(1)),
  creationTime: Schema.NonEmptyString,
  role: Schema.NonEmptyString,
}) satisfies Schema.Schema<ProcessRecord>
const ProbeRecords = Schema.fromJsonString(Schema.Array(ProbeRecord))

/** 锁覆盖旧记录恢复、host 执行和清理；未确认回收的记录保留到下次探测。 */
const makeProbeProcessRecords = Effect.fn('Agents.makeProbeProcessRecords')(function* (directory: string) {
  yield* Effect.promise(() => ensurePrivateDirectory(directory))
  yield* acquireProcessLockScoped(join(directory, 'probe.lock'))
  const file = join(directory, 'processes.json')
  const load = async () => {
    try {
      return Schema.decodeUnknownSync(ProbeRecords)((await readPrivateFile(file)).toString('utf8'))
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return []
      throw error
    }
  }
  let writing = Promise.resolve()
  const update = (change: (records: readonly ProcessRecord[]) => readonly ProcessRecord[]) => {
    const next = writing.then(async () => {
      const records = change(await load())
      await writePrivateFileAtomic(file, JSON.stringify(records))
    })
    writing = next.catch(() => {})
    return next
  }
  const same = (a: ProcessRecord, b: ProcessRecord) =>
    a.pid === b.pid && a.creationTime === b.creationTime && a.role === b.role
  const records: ProcessRecordCallbacks = {
    add: (record) =>
      update((previous) => {
        Schema.decodeUnknownSync(ProbeRecord)(record)
        const existing = previous.find((value) => value.pid === record.pid)
        if (existing && !same(existing, record)) throw new Error('Probe process identity conflict')
        return existing ? previous : [...previous, record]
      }),
    remove: (record) => update((previous) => previous.filter((value) => !same(value, record))),
  }
  const recover = async () => {
    await writing
    for (const record of await load()) {
      const result = await probeInternals.reapProcessTree(record)
      if (result.reaped || result.reason === 'identity-mismatch') await records.remove(record)
      else throw new Error('Probe process cleanup was not confirmed')
    }
  }
  yield* Effect.tryPromise(recover).pipe(Effect.uninterruptible)
  yield* Effect.addFinalizer(() => Effect.tryPromise(recover).pipe(Effect.orDie))
  return records
})

const probeWorkspace = Effect.fn('Agents.probeWorkspace')(function* (options: Omit<AgentHostProcessOptions, 'paths'>) {
  const temporary = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), `baton-${options.agentType}-probe-workspace-`))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  yield* Effect.promise(() => protectPrivateDirectory(temporary))
  const controller = new AbortController()
  yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
  const host = yield* Effect.acquireRelease(
    probeInternals.connect(
      { ...options, paths: { workingDirectory: temporary, privateDirectory: temporary } },
      controller.signal,
    ),
    (host) =>
      Effect.gen(function* () {
        controller.abort()
        yield* host.disconnect.pipe(Effect.ensuring(host.reap.pipe(Effect.ignore)))
      }),
    { interruptible: true },
  )
  return yield* host.probe
})

const probeHost = Effect.fn('Agents.probeHost')(function* (agentType: HostedAgentType, dataDirectory: string) {
  const invocation = currentBatondCommand()
  const watchdog =
    probeInternals.platform() === 'win32'
      ? undefined
      : yield* Effect.acquireRelease(
          Effect.promise(() =>
            probeInternals.startProcessWatchdog({
              file: invocation.executable,
              args: [...invocation.args, 'watchdog'],
            }),
          ),
          (owned) => Effect.promise(() => owned.close()),
        )
  let records: ProcessRecordCallbacks | undefined
  if (!watchdog) {
    const probes = join(dataDirectory, 'agent-probes')
    yield* Effect.promise(async () => {
      await ensurePrivateDirectory(dataDirectory)
      await ensurePrivateDirectory(probes)
    })
    records = yield* makeProbeProcessRecords(join(probes, agentType))
  }
  return yield* Effect.scoped(
    probeWorkspace({
      command: { file: invocation.executable, args: invocation.args },
      agentType,
      ...(watchdog ? { watchdog } : {}),
      ...(records ? { records } : {}),
    }),
  ).pipe(Effect.timeout('30 seconds'))
})

const probeAgent = Effect.fn('Agents.probeAgent')(function* (agentType: HostedAgentType, dataDirectory: string) {
  let version = 'unknown'
  if (agentType === 'cursor') {
    try {
      const installed = probeInternals.inspectCursorSdk()
      version = installed.version
      if (installed.missingAssets.length || installed.version !== installed.platformVersion)
        return hostedAgentReport(agentType, {
          authenticated: 'unknown',
          models: [],
          details: { installed: false, version },
          reason: 'Cursor SDK 安装不完整或平台包版本不符',
        })
    } catch {
      return hostedAgentReport(agentType, {
        authenticated: 'unknown',
        models: [],
        details: { installed: false },
        reason: 'Cursor SDK 安装不完整',
      })
    }
    if (!process.env.CURSOR_API_KEY?.trim())
      return hostedAgentReport(agentType, {
        authenticated: 'missing',
        models: [],
        details: { installed: true, version },
        reason: '需要显式配置 CURSOR_API_KEY',
      })
  }
  const result = yield* Effect.scoped(probeHost(agentType, dataDirectory)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({
            authenticated: 'unknown' as const,
            models: [],
            details: agentType === 'cursor' ? { installed: true, version } : {},
            reason:
              agentType === 'cursor'
                ? 'Cursor 只读探测失败或超时'
                : `${agentCatalog[agentType].name} 安装状态与只读探测暂不可确认`,
          }),
    ),
  )
  return hostedAgentReport(agentType, result)
})

export async function probeAgents(options: {
  readonly dataDirectory: string
  readonly agentTypes?: readonly HostedAgentType[]
  readonly signal?: AbortSignal
}): Promise<readonly RuntimeAgent[]> {
  const types =
    options.agentTypes ??
    (Object.keys(agentCatalog) as Array<keyof typeof agentCatalog>).filter(
      (type): type is HostedAgentType => agentCatalog[type].kind === 'hosted',
    )
  for (const type of types) {
    if (!Object.hasOwn(agentCatalog, type) || agentCatalog[type].kind !== 'hosted')
      throw new AgentError(`Unknown hosted Agent type: ${type}`)
  }
  options.signal?.throwIfAborted()
  return Effect.runPromise(
    Effect.all(
      [...new Set(types)].map((type) => probeAgent(type, options.dataDirectory)),
      { concurrency: 'unbounded' },
    ),
    { signal: options.signal },
  )
}
