import { BUILD, PROTOCOL_VERSION } from '@baton/protocol/release'
import { randomBytes, randomUUID } from 'node:crypto'
import { isSea } from 'node:sea'
import { unlink, chmod, lstat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Cause, Clock, Context, Deferred, Effect, Exit, Option, Schema, Tracer } from 'effect'
import { HttpTraceContext } from 'effect/http'
import { traceParent, waitEvent } from '@baton/telemetry'
import type * as Scope from 'effect/Scope'
import {
  ControlToNodeBody,
  Envelope,
  NodeUpgradeState,
  NodeUpdateAvailability,
  type Frame,
  type NodeIdentity,
  type RuntimeAgent,
  type RuntimeReport,
  type ThreadReport,
} from '@baton/protocol'
import { hasCode } from '../platform/errors.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, openPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { LocalWorkerHost, type DaemonWorkerHost, type BatondCommand } from './host.ts'
import { isMissing, loadIdentity, loadCoordinatorCA, relayURL as normalizeRelay, coordinatorURL } from './identity.ts'
import { initializeBrowseRoots, loadBrowseRoots } from '../devices/roots.ts'
import { makeDeviceService, boundRuntimeReport, type DeviceService } from '../devices/index.ts'
import { makeProjectManager, type ProjectManager, type ProjectManagerOptions } from '../project/index.ts'
import { ProjectRPC } from './project-rpc.ts'
import { makeNodeLedger, contentHash, type NodeLedger } from './ledger.ts'
import { makeThreadService, WorkerHistoryUnavailable } from './threads.ts'
import { makeExecutionService } from '../execution/service.ts'
import { connectWebSocket, reconnectDelay, type DaemonTransport, type DaemonConnection } from './transport.ts'
import { DaemonStorageFailure, ledgerPromise } from './storage.ts'
import { pruneDeviceOutputs } from '../worker/full-output.ts'
import { readLedger } from '../worker/ledger.ts'
import { workerPaths } from './paths.ts'
import { readPrivateFile } from '../platform/private.ts'
import { listenWorker, IPCError } from './ipc.ts'
import { nodeMetricsLoop } from './telemetry.ts'
import type { TelemetryRelay } from './telemetry-relay.ts'
import {
  readUpgradeState,
  prepareUpgradeRequest,
  cancelUpgrade,
  saveUpgradeState,
  upgradeBlockers,
  upgradePaths,
  upgradePaused,
  upgradeOffline,
  type UpgradeState,
} from './upgrade.ts'
import { upgradeStatus } from './upgrade-management.ts'
import { syncingExecutionReports } from './upgrade-execution.ts'
import { pendingNodeUpdate, reportNodeUpdate, reportUpdateAvailability } from './update-network.ts'
import { bootstrapInstallation } from './update-install.ts'
import { beginLocalUpdate, startUpdate } from './update-orchestrator.ts'
import { checkBackgroundUpdate, tryIdleUpdate } from './update-background.ts'
import { isUpdateIdle } from './update-idle.ts'
import { assertNoUpdateRollback, readUpdateState } from './update-state.ts'
import { readOwnProcessIdentity } from '../platform/identity.ts'
export { DaemonStorageFailure } from './storage.ts'

export class NeedsReauthentication extends Error {
  readonly code = 'needs_reauth'
  constructor() {
    super('节点凭据已被拒绝，需要重新认证')
  }
}
export interface RunDaemonOptions {
  readonly dataDirectory: string
  readonly telemetryRelay?: TelemetryRelay
  readonly identity?: NodeIdentity
  readonly relayURL?: string
  readonly caFile?: string
  readonly controlTimeoutSeconds?: number
  readonly heartbeatMs?: number
  readonly pollIntervalMs?: number
  readonly probeIntervalMs?: number
  readonly transport?: DaemonTransport
  readonly probe?: (signal: AbortSignal) => Promise<RuntimeAgent | readonly RuntimeAgent[]>
  readonly host?: DaemonWorkerHost
  readonly executionCommand?: BatondCommand
  readonly random?: () => number
  readonly project?: Omit<ProjectManagerOptions, 'dataDir'>
}
export class DaemonServices extends Context.Service<
  DaemonServices,
  {
    readonly host: DaemonWorkerHost
    readonly transport: DaemonTransport
    readonly probe: (signal: AbortSignal) => Promise<RuntimeAgent | readonly RuntimeAgent[]>
  }
>()('baton/DaemonServices') {}

const pendingCapability = (): RuntimeAgent => ({
  agent_type: 'cursor',
  version: 'unknown',
  status: 'unverified',
  reason: 'Cursor 能力探测尚未完成',
  models: [],
  default_model: '',
  capabilities: { create: false, queue: true, steer: false, stop: true, resume: false, switch_model: false },
})
const attempt = <A>(task: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: task, catch: (error) => (error instanceof Error ? error : new Error('节点运行失败')) })

// Keep the database and lock alive until an interrupted control operation has finished its cleanup.
const controlAttempt = <A>(task: (signal: AbortSignal) => Promise<A>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = new AbortController()
      const pending = yield* Effect.acquireRelease(
        Effect.sync(() => Promise.resolve().then(() => task(controller.signal))),
        (running) =>
          Effect.promise(async () => {
            controller.abort()
            await running.catch(() => undefined)
          }),
      )
      return yield* attempt(() => pending)
    }),
  )
const terminal = (code?: string) =>
  [
    'invalid_credential',
    'invalid_node_credential',
    'node_source_rejected',
    'credential_revoked',
    'node_revoked',
    'needs_reauth',
    'credential_expired',
    'node_idle_expired',
  ].includes(code ?? '')

async function connected(options: {
  dataDirectory: string
  connection: DaemonConnection
  signal: AbortSignal
  identity: NodeIdentity
  tracer: Tracer.Tracer
  connectivity: (online: boolean) => void
  telemetryRelay?: TelemetryRelay
  incarnation: string
  heartbeatMs: number
  controlTimeoutMs: number
  pollMs: number
  ledger?: NodeLedger
  threads?: ReturnType<typeof makeThreadService>
  executions?: ReturnType<typeof makeExecutionService>
  host: DaemonWorkerHost
  report: () => Promise<RuntimeReport>
  projects?: ProjectManager
  devices?: DeviceService
  refreshDevices: () => void
}) {
  const { connection, identity, signal, ledger, threads, executions, projects, devices } = options
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
    connection.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  let synced = false
  let authenticated = false
  let authenticatedAt: number | undefined
  const syncId = randomUUID()
  const started = performance.now()
  let reportPending: { id: string; hash: string; sent: number } | undefined
  let reportAcked = ''
  let upgradePending: { id: string; state: NodeUpgradeState; hash: string; sent: number } | undefined
  let upgradeAcked = ''
  const sentReports = new Map<string, { report: ThreadReport; sentAt: number; span: Tracer.Span }>()
  const sentExecutions = new Map<string, { report: import('@baton/protocol').ExecutionReport; sentAt: number }>()
  let executionPollAt = 0
  const reportAttempts: number[] = []
  const reportRetryMs = Math.max(1000, options.heartbeatMs)
  let reportEpoch = 0
  const requests = new Set<Promise<void>>()
  let failure: unknown
  const send = (frame: Frame) => connection.send(frame)
  const envelope = async (body: unknown, correlation?: string, id: string = randomUUID()) => {
    const env = Schema.decodeUnknownSync(Envelope)({
      version: 1,
      message_id: id,
      route: { to: 'control' },
      priority: 'control',
      ...(correlation ? { correlation_id: correlation } : {}),
      body,
    })
    await send({ kind: 'envelope', envelope: env })
  }
  const projectRPC = new ProjectRPC((request, id) => envelope(request, undefined, id))
  const sync = () =>
    envelope(
      {
        type: 'node.sync',
        display_name: identity.display_name,
        system: identity.system,
        role: identity.role,
        capabilities: identity.capabilities ?? [],
      },
      undefined,
      syncId,
    )
  const schedule = (task: () => Promise<void>) => {
    if (requests.size >= 32) {
      failure = new Error('节点请求队列已满')
      abort()
      return
    }
    const running = task()
      .catch((error: unknown) => {
        failure = error
        abort()
      })
      .finally(() => requests.delete(running))
    requests.add(running)
  }
  const sendReport = async (report: ThreadReport): Promise<boolean> => {
    const now = performance.now()
    while (reportAttempts.length && reportAttempts[0]! <= now - 1000) reportAttempts.shift()
    if (reportAttempts.length >= 32 || (!sentReports.has(report.event_id) && sentReports.size >= 8)) return false
    // Reserve the window before writing so a fast ACK can release the matching entry.
    const parent = traceParent(report.trace_context)
    const span =
      sentReports.get(report.event_id)?.span ??
      options.tracer.span({
        name: 'baton.report',
        parent: parent ? Option.some(parent) : Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: BigInt(Date.now()) * 1_000_000n,
        kind: 'internal',
        root: !parent,
        sampled: parent?.sampled ?? true,
      })
    span.attribute('baton.thread.id', report.thread_id)
    span.attribute('baton.node.id', identity.node_id)
    sentReports.set(report.event_id, { report, sentAt: now, span })
    reportAttempts.push(now)
    await envelope({
      ...report,
      trace_context: {
        traceparent: HttpTraceContext.toHeaders(span).traceparent!,
        ...(report.trace_context?.tracestate ? { tracestate: report.trace_context.tracestate } : {}),
      },
    })
    // Keep the window conservative when encoding or transport delays the actual write.
    reportAttempts[reportAttempts.length - 1] = performance.now()
    return true
  }
  const ticker = async () => {
    let heartbeatAt = 0
    while (!controller.signal.aborted) {
      const now = performance.now()
      if (!authenticated && now - started >= options.controlTimeoutMs) throw new Error('节点认证超时')
      if (authenticatedAt !== undefined && !synced && now - authenticatedAt >= options.controlTimeoutMs)
        throw new Error('节点同步超时')
      if (authenticated && now >= heartbeatAt) {
        await send({ kind: 'heartbeat' })
        if (!synced) await sync()
        heartbeatAt = now + options.heartbeatMs
      }
      if (synced) {
        const saved = await readUpgradeState(options.dataDirectory)
        if (saved) {
          const state = Schema.decodeUnknownSync(NodeUpgradeState)({
            operation_id: saved.operation_id,
            source_version: saved.source_version,
            target_version: saved.target_version,
            phase:
              saved.phase === 'syncing' &&
              reportAcked &&
              ledger &&
              sentReports.size === 0 &&
              (await ledgerPromise(ledger.pendingReports())).length === 0 &&
              sentExecutions.size === 0 &&
              (!executions || (await executions.collectReports()).length === 0)
                ? 'completed'
                : saved.phase,
          })
          const hash = contentHash(state)
          if (
            hash !== upgradeAcked &&
            (upgradePending?.hash !== hash || now - upgradePending.sent >= options.heartbeatMs)
          ) {
            const id = upgradePending?.hash === hash ? upgradePending.id : randomUUID()
            upgradePending = { id, state, hash, sent: now }
            await envelope({ type: 'node.upgrade_state', ...state }, undefined, id)
          }
        }
        const report = await options.report()
        const hash = contentHash(report)
        if (hash !== reportAcked && (!reportPending || now - reportPending.sent >= options.heartbeatMs)) {
          const id = reportPending?.hash === hash ? reportPending.id : randomUUID()
          reportPending = { id, hash, sent: now }
          await envelope({ type: 'node.runtime_report', report }, undefined, id)
        }
        const epoch = reportEpoch
        // oxlint-disable-next-line unicorn/no-useless-spread -- Snapshot reports because sendReport awaits while acknowledgements mutate the map.
        for (const entry of [...sentReports.values()]) {
          if (epoch !== reportEpoch) break
          if (sentReports.get(entry.report.event_id) !== entry || performance.now() - entry.sentAt < reportRetryMs)
            continue
          if (!(await sendReport(entry.report))) break
        }
        if (sentReports.size < 8 && ledger) {
          for (const report of await ledgerPromise(ledger.pendingReports())) {
            if (epoch !== reportEpoch || sentReports.size >= 8) break
            if (sentReports.has(report.event_id)) continue
            if (!(await sendReport(report))) break
          }
        }
        if (executions && now >= executionPollAt) {
          executionPollAt = now + Math.max(1000, options.pollMs)
          for (const report of await executions.collectReports()) {
            const sent = sentExecutions.get(report.event_id)
            if (sent && now - sent.sentAt < reportRetryMs) continue
            if (!sent && sentExecutions.size >= 8) break
            sentExecutions.set(report.event_id, { report, sentAt: now })
            await envelope(report)
          }
        }
      }
      await delay(options.pollMs, undefined, { signal: controller.signal })
    }
  }
  let ticking: Promise<void> | undefined
  try {
    await send({
      kind: 'auth',
      token: identity.credential.token,
      incarnation: options.incarnation,
      daemon_version: BUILD.version,
      protocol_version: PROTOCOL_VERSION,
    })
    ticking = ticker().catch((error: unknown) => {
      if (!controller.signal.aborted) failure = error
      abort()
    })
    for await (const frame of connection.frames) {
      if (frame.kind === 'auth_result') {
        if (authenticated) throw new Error('节点认证协议错误')
        if (!frame.ok) {
          if (frame.code === 'node_version_incompatible')
            throw Object.assign(new Error(frame.message ?? '节点与中心版本不兼容，请升级后重新运行 batond'), {
              code: frame.code,
              version_incompatibility: frame.version_incompatibility,
            })
          if (terminal(frame.code)) throw new NeedsReauthentication()
          if (frame.code === 'incarnation_conflict') throw new Error('节点身份正由另一个进程使用')
          throw new Error('节点认证暂不可用')
        }
        await unlink(join(options.dataDirectory, 'version-incompatible.json')).catch((error: unknown) => {
          if (!isMissing(error)) throw error
        })
        authenticated = true
        authenticatedAt = performance.now()
        await writeDaemonStatus(options.dataDirectory, 'online')
        await sync()
        await send({ kind: 'heartbeat' })
        continue
      }
      if (frame.kind === 'error' && terminal(frame.code)) throw new NeedsReauthentication()
      if (authenticated && frame.kind === 'heartbeat') {
        await send({ kind: 'heartbeat' })
        continue
      }
      if (!authenticated || frame.kind !== 'envelope') continue
      const env = Schema.decodeUnknownSync(Envelope)(frame.envelope)
      if (env.source?.kind !== 'control') continue
      const body = Schema.decodeUnknownSync(ControlToNodeBody)(env.body)
      if (body.type === 'node.sync_result') {
        if (env.correlation_id === syncId) {
          if (body.ok) {
            if (options.telemetryRelay) options.telemetryRelay.send = undefined
            if (body.telemetry?.forward && options.telemetryRelay) {
              const relay = options.telemetryRelay
              relay.send = (signal, payload) => {
                if (!synced) return
                connection.tryTelemetry?.({
                  kind: 'envelope',
                  envelope: {
                    version: 1,
                    message_id: randomUUID(),
                    route: { to: 'control' },
                    priority: '',
                    body: { type: 'telemetry.export', signal, payload },
                  },
                })
              }
            }
            synced = true
            options.connectivity(true)
            projects?.setTransport(projectRPC.request)
            options.refreshDevices()
          } else if (terminal(body.code)) throw new NeedsReauthentication()
        }
        continue
      }
      if (body.type === 'node.runtime_report_result') {
        if (reportPending && env.correlation_id === reportPending.id && body.ok) {
          reportAcked = reportPending.hash
          reportPending = undefined
        }
        continue
      }
      if (body.type === 'node.upgrade_state_result') {
        if (
          upgradePending &&
          env.correlation_id === upgradePending.id &&
          body.operation_id === upgradePending.state.operation_id &&
          body.phase === upgradePending.state.phase &&
          body.ok
        ) {
          if (body.phase === 'completed') {
            const saved = await readUpgradeState(options.dataDirectory)
            if (saved?.operation_id === body.operation_id && saved.phase === 'syncing')
              await saveUpgradeState(options.dataDirectory, { ...saved, phase: 'completed' })
          }
          upgradeAcked = upgradePending.hash
          upgradePending = undefined
        }
        continue
      }
      if (body.type === 'thread.report_result') {
        if (!synced || !ledger) continue
        await ledgerPromise(ledger.acknowledge(body))
        if (body.ok) {
          const sent = sentReports.get(body.event_id)
          if (sent?.report.thread_id === body.thread_id && sent.report.worker_seq === body.worker_seq) {
            sent.span.end(BigInt(Date.now()) * 1_000_000n, Exit.void)
            sentReports.delete(body.event_id)
          }
        } else if (body.expected_worker_seq !== undefined) {
          reportEpoch++
          for (const [id, sent] of sentReports)
            if (sent.report.thread_id === body.thread_id && sent.report.worker_seq >= body.expected_worker_seq) {
              sent.span.end(BigInt(Date.now()) * 1_000_000n, Exit.fail('report_rejected'))
              sentReports.delete(id)
            }
        }
        continue
      }
      if (body.type === 'execution.report_result') {
        if (synced && executions) {
          const sent = sentExecutions.get(body.event_id)
          if (sent && sent.report.execution_id === body.execution_id && sent.report.seq === body.seq && body.ok) {
            await executions.ack(body)
            sentExecutions.delete(body.event_id)
          }
        }
        continue
      }
      if (!ledger || !threads || !executions || !projects || !devices) {
        // 中心将否定命令回执视为最终失败；连接级错误保留原 outbox 供稍后重试。
        if (body.type === 'thread.command')
          await send({ kind: 'error', code: 'node_upgrading', message: '设备已准备升级，请稍后重试原命令' })
        else if (body.type === 'session.request')
          await envelope(
            {
              type: 'session.result',
              operation_id: body.operation_id,
              session_id: body.session_id,
              ok: false,
              code: 'node_upgrading',
              gap: false,
            },
            env.message_id,
          )
        else await send({ kind: 'error', code: 'node_upgrading', message: '设备正在准备升级' })
        continue
      }
      switch (body.type) {
        case 'project_runtime.result':
          if (synced) projectRPC.receive(env.correlation_id, body)
          break
        case 'project_memory_start':
        case 'project_memory_stop':
        case 'project_run_start':
        case 'project_run_stop':
        case 'project_run_wake':
          if (synced) schedule(() => projects.command(body))
          break
        case 'thread.command':
          if (synced)
            schedule(async () => {
              try {
                await envelope(await threads.command(env.message_id, body), env.message_id)
              } catch (error) {
                if (!(error instanceof WorkerHistoryUnavailable)) throw error
              }
            })
          break
        case 'execution.command':
          if (synced)
            schedule(async () => {
              if (body.action === 'start' && (await upgradePaused(options.dataDirectory))) return
              await envelope(await executions.command(body), env.message_id)
            })
          break
        case 'execution.output_request':
          if (synced)
            schedule(async () => {
              await envelope(await executions.output(body), env.message_id)
            })
          break
        case 'files.browse':
        case 'node.browse_roots_set':
        case 'node.browse_roots_get':
        case 'node.project_exec_set':
        case 'node.subscription_login':
        case 'node.model_connection':
        case 'node.subscription_logout':
          if (synced)
            schedule(async () => {
              await envelope(await devices.handle(body, controller.signal), env.message_id)
            })
          break
        case 'session.request':
          if (synced)
            schedule(async () => {
              let result
              try {
                const reply = await options.host.request(
                  body.session_id,
                  { type: 'session_request', ok: false, session_request: body },
                  { timeoutMs: 1000 },
                )
                result = reply.session_result
              } catch {
                /* The public response does not expose local IPC details. */
              }
              await envelope(
                result ?? {
                  type: 'session.result',
                  operation_id: body.operation_id,
                  session_id: body.session_id,
                  ok: false,
                  code: 'worker_unavailable',
                  gap: false,
                },
                env.message_id,
              )
            })
          break
      }
    }
    if (failure) throw failure
    if (!signal.aborted) throw new Error('节点连接已断开')
  } finally {
    if (options.telemetryRelay) options.telemetryRelay.send = undefined
    options.connectivity(false)
    for (const sent of sentReports.values()) sent.span.end(BigInt(Date.now()) * 1_000_000n, Exit.fail('disconnected'))
    abort()
    projectRPC.close()
    projects?.onDisconnect()
    signal.removeEventListener('abort', abort)
    await ticking
    await Promise.allSettled(requests)
  }
}

async function writeDaemonStatus(
  directory: string,
  state: 'connecting' | 'online' | 'rejected' | 'stopping',
  error?: unknown,
) {
  const identity = await readOwnProcessIdentity()
  await writePrivateFileAtomic(
    join(directory, 'daemon-status.json'),
    JSON.stringify({
      pid: process.pid,
      ...(identity ? { creation_time: identity.creationTime } : {}),
      batond_version: BUILD.version,
      state,
      ...(state === 'rejected'
        ? {
            code:
              error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code
                : 'batond_failed',
            message: error instanceof Error ? error.message : '节点运行失败',
          }
        : {}),
      updated_at: new Date().toISOString(),
    }),
  )
}

/** Scope 管理连接、后台任务、节点数据库与进程锁；Worker 独立存活。 */
export const runDaemon = (options: RunDaemonOptions): Effect.Effect<void, Error, Scope.Scope> => {
  const program = Effect.gen(function* () {
    const services = yield* DaemonServices
    const heartbeatMs = options.heartbeatMs ?? 15_000
    const pollMs = options.pollIntervalMs ?? 250
    const probeMs = options.probeIntervalMs ?? 30_000
    const controlTimeoutSeconds = options.controlTimeoutSeconds ?? 370
    if (!Number.isInteger(controlTimeoutSeconds) || controlTimeoutSeconds < 1 || controlTimeoutSeconds > 3600)
      return yield* Effect.fail(new Error('控制等待时限需要 1～3600 秒的整数'))
    if (heartbeatMs < 100 || heartbeatMs > 120_000 || pollMs < 10 || probeMs < 100)
      return yield* Effect.fail(new Error('节点轮询或心跳间隔无效'))
    if (process.platform !== 'win32') process.umask(0o077)
    yield* attempt(() => assertNoUpdateRollback(options.dataDirectory))
    yield* attempt(async () => {
      await ensurePrivateDirectory(options.dataDirectory)
    })
    yield* Effect.acquireRelease(
      attempt(() => acquireProcessLock(join(options.dataDirectory, 'daemon.lock'))),
      (release) => Effect.orDie(attempt(release)),
    )
    yield* Effect.addFinalizer((exit) =>
      Effect.orDie(
        attempt(() => {
          const rejected = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          return writeDaemonStatus(
            options.dataDirectory,
            rejected ? 'rejected' : 'stopping',
            rejected ? Cause.squash(exit.cause) : undefined,
          )
        }),
      ),
    )
    yield* attempt(() => writeDaemonStatus(options.dataDirectory, 'connecting'))
    const identity = options.identity ?? (yield* attempt(() => loadIdentity(options.dataDirectory)))
    const tracer = yield* Tracer.Tracer
    const telemetry = yield* Effect.context<never>()
    const clock = yield* Clock.Clock
    let offlineSince: number | undefined = clock.currentTimeMillisUnsafe()
    void Effect.runPromiseWith(telemetry)(
      waitEvent('start', 'device_offline', { 'baton.node.id': identity.node_id }),
    ).catch(() => {})
    const connectivity = (online: boolean) => {
      try {
        const now = clock.currentTimeMillisUnsafe()
        if (online && offlineSince !== undefined) {
          const duration = now - offlineSince
          offlineSince = undefined
          void Effect.runPromiseWith(telemetry)(
            waitEvent('end', 'device_offline', { 'baton.node.id': identity.node_id }, undefined, duration),
          ).catch(() => {})
        } else if (!online && offlineSince === undefined) {
          offlineSince = now
          void Effect.runPromiseWith(telemetry)(
            waitEvent('start', 'device_offline', { 'baton.node.id': identity.node_id }),
          ).catch(() => {})
        }
      } catch {
        // Telemetry must not change connection handling.
      }
    }
    let address = options.relayURL
    if (!address) {
      if (!identity.coordinator_url) return yield* Effect.fail(new Error('身份缺少中心地址，需要 --relay'))
      address = coordinatorURL(identity.coordinator_url).replace('https:', 'wss:') + '/v1/node'
    }
    const url = yield* Effect.try({ try: () => normalizeRelay(address!), catch: () => new Error('Relay 地址无效') })
    const ca = yield* attempt(() => loadCoordinatorCA(options.dataDirectory, options.caFile))
    let serial: Promise<unknown> = Promise.resolve()
    const paths = upgradePaths(options.dataDirectory)
    const shutdown = yield* Deferred.make<void>()
    if (isSea())
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* attempt(async () => {
              const pending = await pendingNodeUpdate(options.dataDirectory)
              const availabilityPath = join(options.dataDirectory, 'update-availability-pending.json')
              try {
                const bytes = await readPrivateFile(availabilityPath)
                const availability = Schema.decodeUnknownSync(NodeUpdateAvailability)(
                  JSON.parse(bytes.toString('utf8')),
                )
                await reportUpdateAvailability(options.dataDirectory, availability)
                if ((await readPrivateFile(availabilityPath)).equals(bytes)) await unlink(availabilityPath)
              } catch (error) {
                if (!isMissing(error)) throw error
              }
              if (pending.operation_id && pending.attempt) {
                await bootstrapInstallation(options.dataDirectory)
                await startUpdate(options.dataDirectory, {
                  operation_id: pending.operation_id,
                  attempt: pending.attempt,
                })
              }
              const progress = await readUpdateState(options.dataDirectory)
              if (progress && progress.phase !== 'requested')
                await reportNodeUpdate(options.dataDirectory, {
                  operation_id: progress.operation_id,
                  attempt: progress.attempt,
                  phase: progress.phase,
                  ...(progress.phase === 'failed' ? { reason: 'update_failed' } : {}),
                })
            }).pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep('10 seconds')
          }
        }),
      )
    if (isSea())
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* attempt(async () => {
              await tryIdleUpdate(options.dataDirectory, {
                isIdle: () => isUpdateIdle(options.dataDirectory),
                start: async () => {
                  await beginLocalUpdate(options.dataDirectory)
                },
              })
            }).pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep('30 seconds')
          }
        }),
      )
    if (isSea())
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* attempt(async () => {
              await bootstrapInstallation(options.dataDirectory)
              const result = await checkBackgroundUpdate(options.dataDirectory, {
                isIdle: () => isUpdateIdle(options.dataDirectory),
                start: async () => {
                  await beginLocalUpdate(options.dataDirectory)
                },
              })
              const availability = {
                status: result.status === 'current' ? ('current' as const) : ('available' as const),
                version: result.version,
                checked_at: new Date().toISOString(),
              }
              await writePrivateFileAtomic(
                join(options.dataDirectory, 'update-availability.json'),
                JSON.stringify(availability),
              )
              await writePrivateFileAtomic(
                join(options.dataDirectory, 'update-availability-pending.json'),
                JSON.stringify(availability),
              )
              await reportUpdateAvailability(options.dataDirectory, availability)
              await unlink(join(options.dataDirectory, 'update-availability-pending.json')).catch((error: unknown) => {
                if (!isMissing(error)) throw error
              })
            }).pipe(Effect.catch(() => Effect.void))
            yield* Effect.sleep('6 hours')
          }
        }),
      )
    yield* attempt(async () => {
      await ensurePrivateDirectory(join(options.dataDirectory, 'ipc'))
      try {
        await readPrivateFile(paths.token)
      } catch (error) {
        if (!isMissing(error)) throw error
        await writePrivateFileAtomic(paths.token, randomBytes(32).toString('hex'))
      }
      if (process.platform !== 'win32') {
        try {
          const socket = await lstat(paths.endpoint)
          if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('Invalid daemon IPC endpoint')
          await unlink(paths.endpoint)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await serial
      }),
    )
    yield* listenWorker({
      endpoint: paths.endpoint,
      token: (yield* attempt(() => readPrivateFile(paths.token))).toString('utf8'),
      onResponse: (request, response) => {
        if (request.type === 'upgrade_shutdown' && response.ok) Effect.runSync(Deferred.succeed(shutdown, undefined))
      },
      handle: (request) =>
        attempt(async () => {
          const task = serial.then(async () => {
            let state = await readUpgradeState(options.dataDirectory)
            if (request.type === 'upgrade_prepare')
              state = await prepareUpgradeRequest(options.dataDirectory, request.payload, ca)
            else if (request.type === 'upgrade_cancel') state = await cancelUpgrade(options.dataDirectory)
            else if (request.type === 'upgrade_shutdown') {
              if (!state || state.phase !== 'ready' || state.operation_id !== request.payload)
                throw new IPCError('upgrade_conflict', '升级未就绪或操作身份不匹配')
            } else if (request.type !== 'upgrade_status') throw new IPCError('unsupported', '仅支持升级管理命令')
            return {
              type: 'result' as const,
              ok: true,
              payload: JSON.stringify({ state: state ?? null, ...(await upgradeBlockers(options.dataDirectory)) }),
            }
          })
          serial = task.catch(() => {})
          try {
            return await task
          } catch (error) {
            return {
              type: 'result' as const,
              ok: false,
              code: error instanceof IPCError ? error.code : 'upgrade_failed',
              message: error instanceof Error ? error.message : '升级管理失败',
            }
          }
        }),
    })
    if (process.platform !== 'win32') yield* attempt(() => chmod(paths.endpoint, 0o600))
    const incarnation = randomUUID()
    const connect = (
      runtime: Pick<
        Parameters<typeof connected>[0],
        'ledger' | 'threads' | 'executions' | 'projects' | 'devices' | 'report' | 'refreshDevices'
      >,
    ) =>
      Effect.gen(function* () {
        let retry = 0
        while (true) {
          yield* attempt(() => writeDaemonStatus(options.dataDirectory, 'connecting'))
          const started = performance.now()
          const outcome = yield* controlAttempt(async (signal) => {
            let connection: DaemonConnection | undefined
            try {
              connection = await services.transport(url, { signal, ...(ca ? { ca } : {}) })
              await connected({
                dataDirectory: options.dataDirectory,
                connection,
                signal,
                identity,
                tracer,
                connectivity,
                ...(options.telemetryRelay ? { telemetryRelay: options.telemetryRelay } : {}),
                incarnation,
                heartbeatMs,
                controlTimeoutMs: controlTimeoutSeconds * 1000,
                pollMs,
                ...runtime,
                host: services.host,
              })
            } finally {
              connection?.close()
            }
          }).pipe(Effect.result)
          if (
            outcome._tag === 'Failure' &&
            (outcome.failure instanceof NeedsReauthentication || outcome.failure instanceof DaemonStorageFailure)
          )
            return yield* Effect.fail(outcome.failure)
          if (outcome._tag === 'Failure' && hasCode(outcome.failure, 'node_version_incompatible')) {
            yield* attempt(() => writePrivateFileAtomic(join(options.dataDirectory, 'version-incompatible.json'), '{}'))
            yield* attempt(() => writeDaemonStatus(options.dataDirectory, 'rejected', outcome.failure))
            yield* Effect.sleep(reconnectDelay(retry++, options.random))
            continue
          }
          yield* attempt(() => writeDaemonStatus(options.dataDirectory, 'connecting'))
          if (performance.now() - started >= heartbeatMs) retry = 0
          yield* Effect.sleep(reconnectDelay(retry++, options.random))
        }
      })

    const lifecycle = Effect.gen(function* () {
      while (true) {
        const state = yield* attempt(() => readUpgradeState(options.dataDirectory))
        if (state?.phase === 'draining') {
          yield* attempt(async () => {
            const task = serial.then(() => upgradeStatus(options.dataDirectory, true))
            serial = task.catch(() => {})
            await task
          })
          yield* Effect.sleep(100)
          continue
        }
        if (upgradeOffline(state)) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              if (state?.phase === 'syncing')
                yield* controlAttempt(async () => {
                  const file = await openPrivateFile(join(options.dataDirectory, 'node.db'))
                  await file.close()
                })
              const ledger =
                state?.phase === 'syncing'
                  ? yield* makeNodeLedger(join(options.dataDirectory, 'node.db')).pipe(
                      Effect.mapError((cause) => new DaemonStorageFailure(cause)),
                    )
                  : undefined
              if (ledger)
                yield* controlAttempt(async () => {
                  // 补齐已退出 Worker 的持久报告，不启动 Worker 或原生会话。
                  for (const worker of await ledgerPromise(ledger.workers())) {
                    try {
                      const path = workerPaths(options.dataDirectory, worker.threadId).ledger
                      const file = await openPrivateFile(path)
                      await file.close()
                      const state = readLedger(path, worker.config).initial
                      for (const entry of state.outbox)
                        if (!entry.acked) await ledgerPromise(ledger.ingest(entry.report))
                    } catch (error) {
                      if (!isMissing(error)) throw error
                    }
                  }
                })
              yield* Effect.raceFirst(
                connect({
                  ...(ledger
                    ? {
                        ledger,
                        executions: {
                          ...makeExecutionService({ dataDirectory: options.dataDirectory }),
                          ...syncingExecutionReports(options.dataDirectory),
                        },
                      }
                    : {}),
                  report: async () => ({
                    upgrade_protocol: 1,
                    ...(isSea() ? { update_protocol: 1 } : {}),
                    batond_version: BUILD.version,
                    agents: [],
                    roots: [],
                    repos: [],
                    exec: { enabled: false, shell: process.platform === 'win32' ? 'pwsh' : '/bin/sh' },
                  }),
                  refreshDevices: () => {},
                }),
                Effect.gen(function* () {
                  while (upgradeOffline(yield* attempt(() => readUpgradeState(options.dataDirectory))))
                    yield* Effect.sleep(100)
                }),
              )
            }),
          )
          continue
        }
        let draining: UpgradeState | undefined
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* controlAttempt(async () => {
              await initializeBrowseRoots(options.dataDirectory)
              const path = join(options.dataDirectory, 'node.db')
              try {
                const file = await openPrivateFile(path)
                await file.close()
              } catch (error) {
                if (!isMissing(error)) throw error
                await writePrivateFileAtomic(path, '')
              }
            })
            const ledger = yield* makeNodeLedger(join(options.dataDirectory, 'node.db')).pipe(
              Effect.mapError((cause) => new DaemonStorageFailure(cause)),
            )
            let devicesDirty = true
            const projects = yield* Effect.uninterruptible(
              makeProjectManager({
                ...options.project,
                dataDir: options.dataDirectory,
                nodeId: identity.node_id,
                ...(options.telemetryRelay ? { telemetry: options.telemetryRelay } : {}),
                onReportChanged: () => {
                  devicesDirty = true
                  options.project?.onReportChanged?.()
                },
              }),
            )
            yield* Effect.forkScoped(
              nodeMetricsLoop(options.dataDirectory, ledger, projects, () =>
                offlineSince === undefined ? 0 : Math.max(0, (clock.currentTimeMillisUnsafe() - offlineSince) / 1000),
              ),
            )
            const devices = yield* Effect.acquireRelease(
              attempt(() =>
                makeDeviceService({
                  dataDirectory: options.dataDirectory,
                  runtime: projects,
                  onChanged: () => {
                    devicesDirty = true
                  },
                }),
              ),
              (service) => Effect.promise(() => service.close()),
            )
            let agents: RuntimeAgent[] = [pendingCapability()]
            const threads = makeThreadService({
              dataDirectory: options.dataDirectory,
              identity,
              ledger,
              host: services.host,
              capability: () => agents,
              tracer: yield* Tracer.Tracer,
            })
            const executions = makeExecutionService({
              dataDirectory: options.dataDirectory,
              ...(options.executionCommand ? { command: options.executionCommand } : {}),
            })
            yield* controlAttempt(() => executions.recover())
            yield* controlAttempt((signal) => threads.discover(signal))
            let deviceReport: Pick<RuntimeReport, 'exec' | 'roots' | 'repos' | 'project_runtime' | 'truncated'> = {
              exec: { enabled: false, shell: process.platform === 'win32' ? 'pwsh' : '/bin/sh' },
              roots: (yield* attempt(() => loadBrowseRoots(options.dataDirectory))).map((r) => ({
                root_id: r.id,
                path: r.path,
              })),
              repos: [],
            }
            let username: string | undefined
            try {
              username = userInfo().username
            } catch {
              /* The operating system may not provide a user name. */
            }
            const report = async (): Promise<RuntimeReport> =>
              boundRuntimeReport({
                upgrade_protocol: 1,
                ...(isSea() ? { update_protocol: 1 } : {}),
                batond_version: BUILD.version,
                ...(username ? { user: username } : {}),
                agents,
                ...deviceReport,
              })
            const pruneOutputs = Effect.gen(function* () {
              while (true) {
                yield* controlAttempt(() => pruneDeviceOutputs(options.dataDirectory)).pipe(
                  Effect.catch((error) => Effect.logWarning('Full output cleanup failed', error)),
                )
                yield* Effect.sleep('1 hour')
              }
            })
            const collectDevices = Effect.gen(function* () {
              let collectedAt = -Infinity
              while (true) {
                if (devicesDirty || performance.now() - collectedAt >= 5000) {
                  devicesDirty = false
                  yield* controlAttempt(async (signal) => {
                    deviceReport = await devices.collect(signal)
                  })
                  collectedAt = performance.now()
                }
                yield* Effect.sleep(100)
              }
            })
            const collect = Effect.gen(function* () {
              yield* controlAttempt((signal) => threads.recover(signal))
              while (true) {
                yield* controlAttempt((signal) => threads.collectReports(signal))
                yield* Effect.sleep(pollMs)
              }
            })
            const probe = Effect.gen(function* () {
              while (true) {
                yield* controlAttempt(async (signal) => {
                  if (await upgradePaused(options.dataDirectory)) return
                  try {
                    const probed = await services.probe(signal)
                    agents = Array.isArray(probed) ? [...probed] : [probed]
                  } catch {
                    agents = [{ ...pendingCapability(), reason: '能力探测暂不可用' }]
                  }
                })
                yield* Effect.sleep(probeMs)
              }
            })
            const drain = Effect.gen(function* () {
              while (true) {
                const state = yield* attempt(() => readUpgradeState(options.dataDirectory))
                if (state && !['cancelled', 'completed'].includes(state.phase)) {
                  const status = yield* attempt(() => upgradeBlockers(options.dataDirectory))
                  if (state.phase === 'draining' && status.blockers.length === 0) {
                    draining = state
                    return
                  }
                }
                yield* Effect.sleep(100)
              }
            })
            yield* Effect.raceFirst(
              Effect.all(
                [
                  connect({
                    ledger,
                    threads,
                    executions,
                    projects,
                    devices,
                    report,
                    refreshDevices: () => {
                      devicesDirty = true
                    },
                  }),
                  collect,
                  probe,
                  collectDevices,
                  pruneOutputs,
                ],
                { concurrency: 'unbounded' },
              ),
              drain,
            )
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const state = yield* attempt(() => readUpgradeState(options.dataDirectory))
              if (!state || ['cancelled', 'completed'].includes(state.phase)) return yield* Effect.failCause(cause)
              if (state.phase === 'draining' && hasCode(Cause.squash(cause), 'node_version_incompatible')) return
              yield* attempt(() =>
                saveUpgradeState(options.dataDirectory, {
                  ...state,
                  phase: 'failed',
                  reason: Cause.pretty(cause).slice(0, 2048),
                }),
              )
            }),
          ),
        )
        if (draining) {
          const completed = draining as UpgradeState
          yield* attempt(async () => {
            const finish = serial.then(async () => {
              const current = await readUpgradeState(options.dataDirectory)
              if (current?.operation_id === completed.operation_id && current.phase === 'draining')
                await upgradeStatus(options.dataDirectory, true)
            })
            serial = finish.catch(() => {})
            await finish
          })
        }
      }
    })
    yield* Effect.raceFirst(lifecycle, Deferred.await(shutdown))
  })
  return program.pipe(
    Effect.provideService(DaemonServices, {
      host: options.host ?? new LocalWorkerHost(options.dataDirectory, undefined, options.telemetryRelay),
      transport: options.transport ?? connectWebSocket,
      probe:
        options.probe ??
        (async (signal) =>
          (await import('../agents/probe.ts')).probeAgents({ dataDirectory: options.dataDirectory, signal })),
    }),
  )
}
