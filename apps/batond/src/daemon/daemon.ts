import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Effect, Schema, Tracer } from 'effect'
import type * as Scope from 'effect/Scope'
import {
  ControlToNodeBody,
  Envelope,
  type Frame,
  type NodeIdentity,
  type RuntimeAgent,
  type RuntimeReport,
  type ThreadReport,
} from '@baton/protocol'
import { acquireProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, openPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { LocalWorkerHost, type DaemonWorkerHost } from './host.ts'
import { isMissing, loadIdentity, relayURL as normalizeRelay, coordinatorURL } from './identity.ts'
import { initializeBrowseRoots, loadBrowseRoots } from '../devices/roots.ts'
import { makeDeviceService, boundRuntimeReport, type DeviceService } from '../devices/index.ts'
import { makeProjectManager, type ProjectManager, type ProjectManagerOptions } from '../project/index.ts'
import { ProjectRPC } from './project-rpc.ts'
import { makeNodeLedger, contentHash, type NodeLedger } from './ledger.ts'
import { makeThreadService, WorkerHistoryUnavailable } from './threads.ts'
import { connectWebSocket, reconnectDelay, type DaemonTransport, type DaemonConnection } from './transport.ts'
import { DaemonStorageFailure, ledgerPromise } from './storage.ts'
import { pruneDeviceOutputs } from '../worker/full-output.ts'
export { DaemonStorageFailure } from './storage.ts'

export class NeedsReauthentication extends Error {
  readonly code = 'needs_reauth'
  constructor() {
    super('节点凭据已被拒绝，需要重新认证')
  }
}
export interface RunDaemonOptions {
  readonly dataDirectory: string
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
  ].includes(code ?? '')

async function connected(options: {
  connection: DaemonConnection
  signal: AbortSignal
  identity: NodeIdentity
  incarnation: string
  heartbeatMs: number
  controlTimeoutMs: number
  pollMs: number
  ledger: NodeLedger
  threads: ReturnType<typeof makeThreadService>
  host: DaemonWorkerHost
  report: () => Promise<RuntimeReport>
  projects: ProjectManager
  devices: DeviceService
  refreshDevices: () => void
}) {
  const { connection, identity, signal } = options
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
  const sentReports = new Map<string, { report: ThreadReport; sentAt: number }>()
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
    sentReports.set(report.event_id, { report, sentAt: now })
    reportAttempts.push(now)
    await envelope(report)
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
        if (sentReports.size < 8) {
          for (const report of await ledgerPromise(options.ledger.pendingReports())) {
            if (epoch !== reportEpoch || sentReports.size >= 8) break
            if (sentReports.has(report.event_id)) continue
            if (!(await sendReport(report))) break
          }
        }
      }
      await delay(options.pollMs, undefined, { signal: controller.signal })
    }
  }
  let ticking: Promise<void> | undefined
  try {
    await send({ kind: 'auth', token: identity.credential.token, incarnation: options.incarnation })
    ticking = ticker().catch((error: unknown) => {
      if (!controller.signal.aborted) failure = error
      abort()
    })
    for await (const frame of connection.frames) {
      if (frame.kind === 'auth_result') {
        if (authenticated) throw new Error('节点认证协议错误')
        if (!frame.ok) {
          if (terminal(frame.code)) throw new NeedsReauthentication()
          if (frame.code === 'incarnation_conflict') throw new Error('节点身份正由另一个进程使用')
          throw new Error('节点认证暂不可用')
        }
        authenticated = true
        authenticatedAt = performance.now()
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
      switch (body.type) {
        case 'node.sync_result':
          if (env.correlation_id === syncId) {
            if (body.ok) {
              synced = true
              options.projects.setTransport(projectRPC.request)
              options.refreshDevices()
            } else if (terminal(body.code)) throw new NeedsReauthentication()
          }
          break
        case 'node.runtime_report_result':
          if (reportPending && env.correlation_id === reportPending.id && body.ok) {
            reportAcked = reportPending.hash
            reportPending = undefined
          }
          break
        case 'project_runtime.result':
          if (synced) projectRPC.receive(env.correlation_id, body)
          break
        case 'project_run_start':
        case 'project_run_stop':
        case 'project_run_wake':
          if (synced) schedule(() => options.projects.command(body))
          break
        case 'thread.command':
          if (synced)
            schedule(async () => {
              try {
                await envelope(await options.threads.command(env.message_id, body), env.message_id)
              } catch (error) {
                if (!(error instanceof WorkerHistoryUnavailable)) throw error
              }
            })
          break
        case 'thread.report_result':
          if (!synced) break
          await ledgerPromise(options.ledger.acknowledge(body))
          if (body.ok) {
            const sent = sentReports.get(body.event_id)
            if (sent?.report.thread_id === body.thread_id && sent.report.worker_seq === body.worker_seq)
              sentReports.delete(body.event_id)
          } else if (body.expected_worker_seq !== undefined) {
            reportEpoch++
            for (const [id, sent] of sentReports)
              if (sent.report.thread_id === body.thread_id && sent.report.worker_seq >= body.expected_worker_seq)
                sentReports.delete(id)
          }
          break
        case 'files.browse':
        case 'node.browse_roots_set':
        case 'node.browse_roots_get':
        case 'node.project_exec_set':
        case 'node.subscription_login':
          if (synced)
            schedule(async () => {
              await envelope(await options.devices.handle(body, controller.signal), env.message_id)
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
    abort()
    projectRPC.close()
    options.projects.onDisconnect()
    signal.removeEventListener('abort', abort)
    await ticking
    await Promise.allSettled(requests)
  }
}

/** Scope owns the connection, background tasks, node database and process lock. Workers survive it. */
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
    yield* attempt(async () => {
      await ensurePrivateDirectory(options.dataDirectory)
    })
    yield* Effect.acquireRelease(
      attempt(() => acquireProcessLock(join(options.dataDirectory, 'daemon.lock'))),
      (release) => Effect.orDie(attempt(release)),
    )
    const identity = options.identity ?? (yield* attempt(() => loadIdentity(options.dataDirectory)))
    let address = options.relayURL
    if (!address) {
      if (!identity.coordinator_url) return yield* Effect.fail(new Error('身份缺少中心地址，需要 --relay'))
      address = coordinatorURL(identity.coordinator_url).replace('https:', 'wss:') + '/v1/node'
    }
    const url = yield* Effect.try({ try: () => normalizeRelay(address!), catch: () => new Error('Relay 地址无效') })
    const ca = options.caFile ? yield* attempt(() => readFile(options.caFile!, 'utf8')) : undefined
    yield* attempt(async () => {
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
      Effect.mapError(() => new DaemonStorageFailure()),
    )
    let devicesDirty = true
    const projects = yield* makeProjectManager({
      ...options.project,
      dataDir: options.dataDirectory,
      onReportChanged: () => {
        devicesDirty = true
        options.project?.onReportChanged?.()
      },
    })
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
        batond_version: '0.0.0',
        ...(username ? { user: username } : {}),
        agents,
        ...deviceReport,
      })
    const pruneOutputs = Effect.gen(function* () {
      while (true) {
        yield* attempt(() => pruneDeviceOutputs(options.dataDirectory)).pipe(
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
        yield* attempt(async (signal) => {
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
    const incarnation = randomUUID()
    const connect = Effect.gen(function* () {
      let retry = 0
      while (true) {
        const started = performance.now()
        const outcome = yield* controlAttempt(async (signal) => {
          let connection: DaemonConnection | undefined
          try {
            connection = await services.transport(url, { signal, ...(ca ? { ca } : {}) })
            await connected({
              connection,
              signal,
              identity,
              incarnation,
              heartbeatMs,
              controlTimeoutMs: controlTimeoutSeconds * 1000,
              pollMs,
              ledger,
              threads,
              host: services.host,
              report,
              projects,
              devices,
              refreshDevices: () => {
                devicesDirty = true
              },
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
        if (performance.now() - started >= heartbeatMs) retry = 0
        yield* Effect.sleep(reconnectDelay(retry++, options.random))
      }
    })
    yield* Effect.all([connect, collect, probe, collectDevices, pruneOutputs], { concurrency: 'unbounded' })
  })
  return program.pipe(
    Effect.provideService(DaemonServices, {
      host: options.host ?? new LocalWorkerHost(options.dataDirectory),
      transport: options.transport ?? connectWebSocket,
      probe:
        options.probe ??
        (async () => (await import('../agents/probe.ts')).probeAgents({ dataDirectory: options.dataDirectory })),
    }),
  )
}
