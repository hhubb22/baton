import { createHash } from 'node:crypto'
import { upgradePaused, readUpgradeState, upgradeOffline } from '../daemon/upgrade.ts'
import { assertNoUpdateRollback } from '../daemon/update-state.ts'
import { IPCError } from '../daemon/ipc.ts'
import { join } from 'node:path'
import { rm, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { Context, Effect, Schema, Predicate } from 'effect'
import { waitEvent } from '@baton/telemetry'
import { ProjectRunCommand, ProjectRuntimeRequest, ProjectRuntimeResult } from '@baton/protocol'
import { readProjectRuntimeConfig } from '../devices/config.ts'
import { ensurePrivateDirectory, openPrivateFile } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import { identityMatches } from '../platform/identity.ts'
import { startProcessWatchdog, reapProcessTree, type OwnedProcess, type ProcessWatchdog } from '../platform/process.ts'
import { makeProjectLedger, type ProjectLedger } from './ledger.ts'
import { RuntimeRunner, defaultWatchdogCommand } from './runner.ts'
import { RuntimeWaits } from './waits.ts'
import { serveRuntime } from './stdio.ts'
import {
  LeaseClock,
  failure,
  MAX_FRAME,
  type ProjectManager,
  type ProjectManagerOptions,
  type ProjectTransport,
} from './types.ts'

interface Run {
  command: ProjectRunCommand
  cancel: AbortController
  waits: RuntimeWaits
  done: Promise<void>
  owned?: OwnedProcess
  lastRenew: number
  lastAttempt: number
  started: boolean
  renewing: boolean
  hostCheckSeq: number
  cleanupPending: boolean
  cleanupReady: boolean
  cleanupUncertain: boolean
  deferred: boolean
  control: string
}
const safePromise = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)

class Manager implements ProjectManager {
  private transport: { request: ProjectTransport; cancel: AbortController; receipts: boolean } | undefined
  private readonly cancel = new AbortController()
  private readonly clock: LeaseClock
  private readonly runs = new Map<string, Run>()
  private readonly tasks = new Set<Promise<unknown>>()
  private serial = Promise.resolve()
  private readonly runner: RuntimeRunner
  private readonly renewMs: number
  private readonly leaseMs: number
  private readonly timer: NodeJS.Timeout
  private readonly cleanupTimer: NodeJS.Timeout
  private cleanupBusy = false
  private closing?: Promise<void>
  private readonly wakes: { command: ProjectRunCommand; transport: NonNullable<Manager['transport']> }[] = []
  private wakeBusy = false

  constructor(
    private readonly options: ProjectManagerOptions,
    private readonly ledger: ProjectLedger,
    private readonly watchdog?: ProcessWatchdog,
    private readonly telemetry?: Context.Context<never>,
  ) {
    this.clock = new LeaseClock(options.clock)
    this.renewMs = options.timing?.renewMs ?? 20000
    this.leaseMs = options.timing?.leaseMs ?? 58000
    const check = options.timing?.checkMs ?? 200
    if (
      ![this.renewMs, this.leaseMs, check].every(Number.isFinite) ||
      this.renewMs <= 0 ||
      this.leaseMs <= this.renewMs ||
      check <= 0 ||
      check > 1000
    )
      throw new Error('Project Runtime 租约计时配置无效')
    this.runner = new RuntimeRunner(options, watchdog, ledger.records)
    this.timer = setInterval(() => this.checkRuns(), check)
    this.cleanupTimer = setInterval(() => this.cleanup(), 200)
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.tasks.add(promise)
    void promise.finally(() => this.tasks.delete(promise)).catch(() => {})
    return promise
  }
  setTransport(request?: ProjectTransport) {
    this.transport?.cancel.abort()
    this.transport =
      request && !this.cancel.signal.aborted ? { request, cancel: new AbortController(), receipts: false } : undefined
    this.checkRuns()
    this.cleanup()
  }
  onDisconnect() {
    this.setTransport()
  }
  probe = (signal?: AbortSignal) => this.runner.probe(signal)
  subscriptions = (signal?: AbortSignal) => this.probe(signal)
  configureConnection = (
    action: 'save' | 'delete' | 'get',
    connection: import('@baton/protocol').ModelConnection,
    signal?: AbortSignal,
  ) => this.runner.configureConnection(action, connection, signal)
  logout = (provider: string, signal?: AbortSignal) => this.runner.logout(provider, signal)
  report = (signal?: AbortSignal) => this.runner.report(signal)
  login = (provider: string, signal?: AbortSignal) => this.runner.login(provider, signal)
  startDeviceLogin = (provider: string, signal?: AbortSignal, onDone?: () => void) =>
    this.runner.startDeviceLogin(provider, signal, onDone)

  private async call(
    request: ProjectRuntimeRequest,
    parent?: AbortSignal,
    timeout = 5000,
    fixed = this.transport,
  ): Promise<ProjectRuntimeResult> {
    if (!fixed || this.transport !== fixed) return failure('unavailable')
    const signal = AbortSignal.any([
      this.cancel.signal,
      fixed.cancel.signal,
      AbortSignal.timeout(timeout),
      ...(parent ? [parent] : []),
    ])
    let abort: (() => void) | undefined
    try {
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(request)) > MAX_FRAME) return failure('invalid_request')
      const result = await Promise.race([
        fixed.request(request, signal),
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error('Project Runtime 请求已取消'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }),
      ])
      signal.throwIfAborted()
      if (this.transport !== fixed) return failure('unavailable')
      const validated = Schema.decodeUnknownSync(ProjectRuntimeResult)(result)
      if (validated.ok && (request.operation === 'started' || request.operation === 'renew')) {
        fixed.receipts = Predicate.isObject(validated.data) && validated.data.control_receipts === 1
      }
      return validated
    } catch {
      return failure('unavailable')
    } finally {
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  private management(
    command: Pick<ProjectRunCommand, 'run_id' | 'lease_epoch'>,
    operation: ProjectRuntimeRequest['operation'],
    reason?: string,
  ) {
    return this.call({
      type: 'project_runtime.request',
      run_id: command.run_id,
      lease_epoch: command.lease_epoch,
      operation,
      ...(reason ? { reason } : {}),
    })
  }
  private lease(run: Run) {
    const now = this.clock.now()
    if (run.cancel.signal.aborted || now - run.lastRenew >= this.leaseMs) {
      run.cancel.abort()
      throw new Error('lease_lost')
    }
    return now
  }
  private checkRuns() {
    if (this.cancel.signal.aborted) return
    this.serial = this.serial
      .then(async () => {
        const paused = await upgradePaused(this.options.dataDir)
        if (paused) {
          for (const run of this.runs.values()) {
            if (run.command.type === 'project_memory_start') this.stop(run)
            else run.waits.notify()
          }
        } else {
          for (const row of await safePromise(this.ledger.pending())) {
            if (this.cancel.signal.aborted || (await upgradePaused(this.options.dataDir))) break
            const command = Schema.decodeUnknownSync(ProjectRunCommand)(JSON.parse(row.payload))
            if (command.type === 'project_run_wake') this.wake(command)
            else await this.reserve(command)
            const saved = await safePromise(this.ledger.get(command.run_id))
            if (!saved || !['starting', 'queued'].includes(saved.state))
              await safePromise(this.ledger.delivered(row.id))
          }
        }
      })
      .catch(() => {})
    for (const run of this.runs.values()) {
      if (!run.started || run.cleanupPending) continue
      try {
        const now = this.lease(run)
        if (!run.renewing && now - run.lastAttempt >= this.renewMs) {
          run.renewing = true
          run.lastAttempt = now
          this.track(this.renew(run, now))
            .finally(() => {
              run.renewing = false
            })
            .catch(() => {})
        }
      } catch {
        this.stop(run)
      }
    }
  }
  private async renew(run: Run, started: number) {
    const attributes = {
      'baton.project.run.id': run.command.run_id,
      ...(run.command.project_id ? { 'baton.project.id': run.command.project_id } : {}),
    }
    if (this.telemetry)
      await Effect.runPromiseWith(this.telemetry)(waitEvent('start', 'lease', attributes, run.command.trace)).catch(
        () => {},
      )
    try {
      this.lease(run)
      if (!run.owned || !(await identityMatches(run.owned.record))) throw new Error('runtime_lost')
      this.lease(run)
      const result = await this.call(
        {
          type: 'project_runtime.request',
          run_id: run.command.run_id,
          lease_epoch: run.command.lease_epoch,
          operation: 'renew',
          payload: { host_check_seq: ++run.hostCheckSeq },
        },
        run.cancel.signal,
      )
      this.lease(run)
      if (result.ok) run.lastRenew = started
      else if (['lease_lost', 'claim_lost', 'node_idle_expired'].includes(result.code ?? '')) this.stop(run)
    } catch {
      this.stop(run)
    } finally {
      try {
        if (this.telemetry)
          await Effect.runPromiseWith(this.telemetry)(
            waitEvent('end', 'lease', attributes, run.command.trace, Math.max(0, this.clock.now() - started)),
          )
      } catch {
        // Telemetry must not change lease handling.
      }
    }
  }
  leaseWaitAge() {
    const now = this.clock.now()
    return Math.max(
      0,
      ...[...this.runs.values()].filter((run) => run.renewing).map((run) => (now - run.lastAttempt) / 1000),
    )
  }
  private stop(run: Run) {
    run.cancel.abort()
    run.waits.signal()
    if (run.owned) this.track(this.runner.reap(run.owned)).catch(() => {})
  }
  async command(input: ProjectRunCommand) {
    await assertNoUpdateRollback(this.options.dataDir)
    const decoded = Schema.decodeUnknownOption(ProjectRunCommand)(input)
    if (decoded._tag === 'None' || decoded.value.lease_epoch <= 0 || this.cancel.signal.aborted) return
    const command = decoded.value
    if (upgradeOffline(await readUpgradeState(this.options.dataDir)))
      throw new IPCError('node_upgrading', '设备已准备升级')
    const queued = this.serial.then(async () => {
      const { trace: _trace, ...content } = command
      const id = createHash('sha256').update(JSON.stringify(content)).digest('hex')
      await safePromise(this.ledger.enqueue(id, command))
      if (
        (await upgradePaused(this.options.dataDir)) &&
        !['project_run_stop', 'project_memory_stop'].includes(command.type)
      )
        return
      if (command.type === 'project_run_wake') this.wake(command)
      else await this.reserve(command)
      const saved = await safePromise(this.ledger.get(command.run_id))
      if (
        !saved ||
        !['starting', 'queued'].includes(saved.state) ||
        ['project_run_stop', 'project_memory_stop'].includes(command.type)
      )
        await safePromise(this.ledger.delivered(id))
    })
    this.serial = queued.catch(() => {})
    await queued
  }
  private async reserve(command: ProjectRunCommand) {
    if (this.cancel.signal.aborted) return
    const run = this.runs.get(command.run_id)
    if (run) {
      if (run.command.lease_epoch !== command.lease_epoch) return
      if (command.type === 'project_run_stop' || command.type === 'project_memory_stop') this.stop(run)
      else if (run.started && !run.cancel.signal.aborted) {
        try {
          this.lease(run)
          this.track(this.management(command, 'started')).catch(() => {})
        } catch {
          this.stop(run)
        }
      }
      return
    }
    const old = await safePromise(this.ledger.get(command.run_id))
    if (old && old.state !== 'queued') {
      if (
        old.lease_epoch === command.lease_epoch &&
        (command.type === 'project_run_start' || command.type === 'project_memory_start')
      )
        this.track(
          this.management(command, old.state === 'failed' ? 'start_failed' : 'exited', old.reason || 'runtime_lost'),
        ).catch(() => {})
      this.cleanup()
      return
    }
    if (command.type === 'project_run_stop' || command.type === 'project_memory_stop') {
      await safePromise(this.ledger.insert(command, true))
      if (old?.state === 'queued') {
        await safePromise(this.ledger.state(command.run_id, 'exited', 'stopped_before_start'))
        await safePromise(this.ledger.complete(command.run_id))
      }
      this.cleanup()
      return
    }
    const config = await readProjectRuntimeConfig(this.options.dataDir).catch(() => undefined)
    if (!config) {
      void this.track(this.management(command, 'start_failed', 'config_unavailable'))
      return
    }
    if ((await safePromise(this.ledger.occupied())) >= config.maxConcurrentProjects) {
      void this.track(this.management(command, 'start_failed', 'capacity_exceeded'))
      return
    }
    const intent = await safePromise(this.ledger.insert(command))
    if (!intent.inserted) {
      if (intent.row.state !== 'queued') return
      await safePromise(this.ledger.state(command.run_id, 'starting', ''))
    }
    const pending: Run = {
      command,
      cancel: new AbortController(),
      waits: new RuntimeWaits(),
      done: Promise.resolve(),
      lastRenew: this.clock.now(),
      lastAttempt: this.clock.now(),
      started: false,
      renewing: false,
      hostCheckSeq: 0,
      cleanupPending: false,
      cleanupReady: false,
      cleanupUncertain: false,
      deferred: false,
      control: join(this.options.dataDir, 'project-runtimes', command.run_id),
    }
    this.runs.set(command.run_id, pending)
    pending.done = this.track(this.start(pending))
  }
  private async start(run: Run) {
    let clean = true
    let stdio: Promise<void> | undefined
    let activate!: (ready: boolean) => void
    const registered = new Promise<boolean>((resolve) => {
      activate = resolve
    })
    try {
      const report = await this.probe(run.cancel.signal)
      const provider = report.providers?.find((p) => p.provider === run.command.provider)
      const embeddingOnly = run.command.memory_kind === 'embedding'
      if (!embeddingOnly && (!provider || provider.status === 'login_required')) {
        this.options.onReportChanged?.()
        await this.failed(run, provider ? 'login_required' : 'provider_missing')
        return
      }
      if (
        !embeddingOnly &&
        provider?.reason &&
        [
          'credential_permissions_invalid',
          'credential_owner_invalid',
          'credential_path_invalid',
          'credential_private_file_failed',
        ].includes(provider.reason)
      ) {
        await this.failed(run, provider.reason)
        return
      }
      run.cancel.signal.throwIfAborted()
      const started = this.clock.now()
      run.lastRenew = started
      const initial = await this.call(
        {
          type: 'project_runtime.request',
          run_id: run.command.run_id,
          lease_epoch: run.command.lease_epoch,
          operation: 'renew',
        },
        run.cancel.signal,
      )
      this.lease(run)
      if (!initial.ok) {
        await this.failed(run, initial.code ?? 'unavailable')
        return
      }
      await ensurePrivateDirectory(join(this.options.dataDir, 'project-runtimes'))
      await ensurePrivateDirectory(run.control)
      this.lease(run)
      const config = await readProjectRuntimeConfig(this.options.dataDir)
      if (await upgradePaused(this.options.dataDir)) {
        // 尚未启动的运行回到持久命令队列，保留原租约身份。
        run.deferred = true
        await safePromise(this.ledger.state(run.command.run_id, 'queued', ''))
        this.runs.delete(run.command.run_id)
        return
      }
      run.owned = await this.runner.spawn(
        [
          run.command.type === 'project_memory_start' ? 'memory' : 'run',
          '--max-output-tokens',
          String(config.maxOutputTokens),
          '--max-model-calls',
          String(config.maxModelCalls),
        ],
        run.cancel.signal,
        run.command.run_id,
        run.control,
        {
          BATON_PROJECT_RUNTIME_TRANSPORT: 'stdio',
          BATON_PROJECT_RUN_ID: run.command.run_id,
          BATON_PROJECT_LEASE_EPOCH: String(run.command.lease_epoch),
          ...(this.options.nodeId ? { BATON_TELEMETRY_NODE_ID: this.options.nodeId } : {}),
        },
        (child) => {
          stdio = serveRuntime(
            child.stdout,
            child.stdin,
            async (value) => {
              if (!(await registered)) return failure('unavailable')
              return this.runtimeRequest(run, value)
            },
            run.cancel.signal,
            (request, result) => {
              if (result.ok && (request.operation === 'finish' || request.operation === 'report_failure')) {
                // Allow the Runtime to close its telemetry exporter before reclaiming a stalled process.
                const timer = setTimeout(() => this.stop(run), 5000)
                timer.unref()
                void run.owned?.exited.finally(() => clearTimeout(timer))
              }
            },
          )
          void stdio.then(
            () => this.stop(run),
            () => this.stop(run),
          )
        },
      )
      run.started = true
      run.lastAttempt = started
      await safePromise(this.ledger.state(run.command.run_id, 'running', ''))
      activate(true)
      void this.track(
        this.call(
          {
            type: 'project_runtime.request',
            run_id: run.command.run_id,
            lease_epoch: run.command.lease_epoch,
            operation: 'started',
          },
          run.cancel.signal,
        ).then((result) => {
          try {
            this.lease(run)
            if (!result.ok && result.code !== 'unavailable') this.stop(run)
          } catch {
            this.stop(run)
          }
        }),
      )
      await run.owned.exited
      this.stop(run)
      await this.runner.reap(run.owned)
      await stdio?.catch(() => {})
    } catch (error) {
      if (!run.started) await this.failed(run, 'unavailable').catch(() => {})
      if (error instanceof AggregateError) clean = false
    } finally {
      activate(false)
      if (!run.deferred) {
        this.stop(run)
        if (run.owned) {
          try {
            await this.runner.reap(run.owned)
          } catch {
            clean = false
          }
        }
        try {
          await stdio?.catch(() => {})
          await rm(run.control, { recursive: true, force: true })
        } catch {
          clean = false
        }
        run.cleanupUncertain = !clean && !run.owned
        run.cleanupReady = true
        if (clean) {
          run.cleanupPending = true
          await this.persistCleanup(run)
        }
      }
    }
  }
  private async failed(run: Run, reason: string) {
    await safePromise(this.ledger.state(run.command.run_id, 'failed', reason))
    await this.management(run.command, 'start_failed', reason)
  }
  private async persistCleanup(run: Run) {
    try {
      await safePromise(this.ledger.complete(run.command.run_id))
      if (this.runs.get(run.command.run_id) === run) this.runs.delete(run.command.run_id)
    } catch {
      /* 内存中的清理事实保留到下一轮持久化。 */
    }
  }
  private async runtimeRequest(run: Run, value: Record<string, unknown>): Promise<ProjectRuntimeResult> {
    try {
      const started = this.lease(run)
      if (value.operation === 'poll_wake' && (await upgradePaused(this.options.dataDir)))
        return { type: 'project_runtime.result', ok: true, data: {} }
      if (value.operation === 'poll_wake')
        return await run.waits.poll(value.payload, run.cancel.signal, () => this.lease(run))
      const decoded = Schema.decodeUnknownOption(ProjectRuntimeRequest)({
        ...value,
        type: 'project_runtime.request',
        run_id: run.command.run_id,
        lease_epoch: run.command.lease_epoch,
      })
      if (decoded._tag === 'None') return failure('invalid_request')
      const request = decoded.value
      if (
        run.command.type !== 'project_memory_start' &&
        request.operation === 'claim_inputs' &&
        (await upgradePaused(this.options.dataDir))
      ) {
        await this.call({ ...request, operation: 'finish', reason: 'idle' }, run.cancel.signal)
        // 领取下一批输入之前已保存当前回合，可以关闭 Runtime 而不撤回输入。
        this.stop(run)
        return failure('lease_lost')
      }
      if (
        !(
          run.command.type === 'project_memory_start'
            ? [
                'memory_bootstrap',
                'read_sources',
                'lookup_items',
                'commit_chunk',
                'pending_embeddings',
                'commit_embedding',
                'defer_embedding',
                'finish',
                'report_failure',
              ]
            : [
                'bootstrap',
                'read_events',
                'claim_inputs',
                'embedding_query',
                'prepare_context',
                'append_event',
                'commit_compaction',
                'preview',
                'call_tool',
                'wait_tool',
                'report_failure',
                'finish',
              ]
        ).includes(request.operation)
      )
        return failure('invalid_request')
      const call = ['call_tool', 'wait_tool'].includes(request.operation)
        ? run.waits.begin(request.tool_call_id)
        : undefined
      let result = await this.call(request, run.cancel.signal, 30000)
      result = run.waits.finish(call, request, result, started)
      this.lease(run)
      if (result.ok && (request.operation === 'bootstrap' || request.operation === 'memory_bootstrap')) {
        const data = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(result.data)
        if (data._tag === 'None') return failure('unavailable')
        result = Schema.decodeUnknownSync(ProjectRuntimeResult)({
          ...result,
          data: {
            ...data.value,
            ...(request.operation === 'bootstrap' ? { local_wait_protocol: 1 } : {}),
            ...(run.command.project_id ? { project_id: run.command.project_id } : {}),
            ...(run.command.trace ? { trace: run.command.trace } : {}),
          },
        })
      }
      if (result.code === 'lease_lost' || result.code === 'claim_lost' || result.code === 'node_idle_expired') {
        const timer = setTimeout(() => this.stop(run), 100)
        timer.unref()
      }
      return result
    } catch {
      this.stop(run)
      return failure('lease_lost')
    }
  }
  private wake(command: ProjectRunCommand) {
    if ((command.input_ids?.length ?? 0) > 32 || command.input_ids?.some((id) => id <= 0)) return
    const run = this.runs.get(command.run_id)
    if (!run || run.command.lease_epoch !== command.lease_epoch || run.cancel.signal.aborted) return
    try {
      if (run.started) this.lease(run)
    } catch {
      this.stop(run)
      return
    }
    run.waits.notify(command.execution_updates ?? [])
    const transport = this.transport
    if (transport?.receipts && command.input_ids?.length && this.wakes.length < 64) {
      this.wakes.push({ command, transport })
      this.sendWakes()
    }
  }
  private sendWakes() {
    if (this.wakeBusy || this.cancel.signal.aborted) return
    this.wakeBusy = true
    this.track(
      (async () => {
        while (this.wakes.length && !this.cancel.signal.aborted) {
          const item = this.wakes.shift()!
          const run = this.runs.get(item.command.run_id)
          if (!run || item.transport !== this.transport || !item.transport.receipts) continue
          try {
            this.lease(run)
          } catch {
            this.stop(run)
            continue
          }
          await this.call(
            {
              type: 'project_runtime.request',
              run_id: run.command.run_id,
              lease_epoch: run.command.lease_epoch,
              operation: 'wake_received',
              payload: { input_ids: [...(item.command.input_ids ?? [])] },
            },
            run.cancel.signal,
            5000,
            item.transport,
          )
        }
      })(),
    )
      .finally(() => {
        this.wakeBusy = false
      })
      .catch(() => {})
  }
  private cleanup() {
    if (this.cleanupBusy || this.cancel.signal.aborted) return
    this.cleanupBusy = true
    this.track(
      (async () => {
        for (const run of this.runs.values()) {
          if (!run.cleanupReady || run.cleanupUncertain) continue
          if (!run.cleanupPending) {
            try {
              if (run.owned) await this.runner.reap(run.owned)
              await rm(run.control, { recursive: true, force: true })
              run.cleanupPending = true
            } catch {
              continue
            }
          }
          await this.persistCleanup(run)
        }
        for (let count = 0; count < 32 && this.transport && !this.cancel.signal.aborted; count++) {
          const row = await safePromise(this.ledger.claim(Date.now()))
          if (!row) break
          const command = { run_id: row.run_id, lease_epoch: row.lease_epoch }
          const budget = AbortSignal.timeout(5000)
          const exited = await this.call(
            { type: 'project_runtime.request', ...command, operation: 'exited', reason: row.reason },
            budget,
          )
          if (!exited.ok && exited.code !== 'lease_lost') continue
          if ((await this.call({ type: 'project_runtime.request', ...command, operation: 'stopped' }, budget)).ok)
            await safePromise(this.ledger.ack(row.run_id, row.lease_epoch))
        }
      })(),
    )
      .finally(() => {
        this.cleanupBusy = false
      })
      .catch(() => {})
  }
  async recover() {
    for (const record of await safePromise(this.ledger.processes())) {
      const result = await reapProcessTree(record)
      // pid 已被复用说明记录指向的进程早已退出，与 Worker 账本的处理一致：清掉记录而不是永久保留。
      if (!result.reaped && result.reason !== 'identity-mismatch') continue
      await this.ledger.records.remove(record)
      const row = await safePromise(this.ledger.get(record.role))
      if (row) {
        await rm(join(this.options.dataDir, 'project-runtimes', row.run_id), { recursive: true, force: true })
        await safePromise(this.ledger.complete(row.run_id))
      }
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.cancel.abort()
      this.transport?.cancel.abort()
      this.transport = undefined
      clearInterval(this.timer)
      clearInterval(this.cleanupTimer)
      await this.serial
      for (const run of this.runs.values()) this.stop(run)
      await Promise.allSettled(this.tasks)
      await this.runner.close()
      for (const run of this.runs.values()) if (run.cleanupPending) await this.persistCleanup(run)
    })())
  }
}

export const makeProjectManager = Effect.fn('Project.makeProjectManager')(function* (options: ProjectManagerOptions) {
  const telemetry = yield* Effect.context<never>()
  yield* Effect.tryPromise(() => ensurePrivateDirectory(options.dataDir))
  const filename = join(options.dataDir, 'project-runtime.db')
  // 创建数据库文件后再连接，沿用节点私有目录与文件权限。
  yield* Effect.tryPromise(async () => {
    try {
      const file = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await file.close()
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    const file = await openPrivateFile(filename)
    await file.close()
    await ensurePrivateDirectory(join(options.dataDir, 'project-runtimes'))
  })
  const ledger = yield* makeProjectLedger(filename)
  const watchdog =
    process.platform === 'win32'
      ? undefined
      : yield* Effect.acquireRelease(
          Effect.tryPromise(() => startProcessWatchdog(options.watchdogCommand ?? defaultWatchdogCommand())),
          (watchdog) => Effect.promise(() => watchdog.close()).pipe(Effect.orDie),
        )
  const manager = yield* Effect.acquireRelease(
    Effect.sync(() => new Manager(options, ledger, watchdog, telemetry)),
    (manager) => Effect.promise(() => manager.close()).pipe(Effect.orDie),
  )
  yield* Effect.tryPromise(() => manager.recover())
  return manager as ProjectManager
})
