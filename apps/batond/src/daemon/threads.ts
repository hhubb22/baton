import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Schema, type Tracer } from 'effect'
import { tracePromise } from '@baton/telemetry'
import {
  ThreadReport,
  WorkerCommandResult,
  WorkerRequest,
  type NodeIdentity,
  type RuntimeAgent,
  type ThreadCommand,
  type ThreadCommandResult,
  type WorkerIPCMessage,
} from '@baton/protocol'
import { authorizeDirectory } from '../devices/roots.ts'
import { upgradePaused, readUpgradeState } from './upgrade.ts'
import { workerPaths } from './paths.ts'
import { contentHash, type NodeLedger, type NodeCommand } from './ledger.ts'
import { DaemonStorageFailure, ledgerPromise as io } from './storage.ts'
import { makeWorkerRecovery } from './recovery.ts'
import type { DaemonWorkerHost } from './host.ts'

class AdmissionRejected extends Error {
  constructor(
    readonly code: string,
    readonly reason?: string,
  ) {
    super(code)
  }
}

/** No negative receipt may be inferred from an interrupted or unverifiable handoff. */
export class CommandDeliveryUncertain extends Error {
  constructor() {
    super('Worker 命令接收结果尚未确认，需要使用原命令 ID 恢复')
  }
}

export class WorkerHistoryUnavailable extends Error {
  constructor() {
    super('Worker 账本不可用，等待持久历史缺失报告确认')
  }
}

const workerRejections = new Set([
  'invalid_request',
  'command_conflict',
  'identity_mismatch',
  'invalid_state',
  'unsupported',
  'message_conflict',
  'model_with_steer',
  'not_queued',
])
const decodeRequest = (value: unknown): WorkerRequest => {
  try {
    return Schema.decodeUnknownSync(WorkerRequest)(value)
  } catch {
    throw new AdmissionRejected('invalid_request')
  }
}

export function makeThreadService(options: {
  dataDirectory: string
  identity: NodeIdentity
  ledger: NodeLedger
  host: DaemonWorkerHost
  tracer?: Tracer.Tracer
  capability: () => RuntimeAgent | readonly RuntimeAgent[]
}) {
  const { ledger, host } = options
  const recovery = makeWorkerRecovery({ dataDirectory: options.dataDirectory, ledger, host })
  const inFlight = new Map<string, { hash: string; result: Promise<ThreadCommandResult> }>()
  const commandHash = ({ trace_context: _trace, ...business }: ThreadCommand) => contentHash(business)
  async function deliver(saved: NodeCommand, deadline: number, reconcile: boolean): Promise<ThreadCommandResult> {
    return tracePromise(
      options.tracer,
      'baton.worker.dispatch',
      saved.request.trace_context,
      (trace) => deliverRequest(saved, deadline, reconcile, trace),
      {
        kind: 'client',
        attributes: { 'baton.command.id': saved.id, 'baton.recovery': reconcile },
      },
    )
  }
  async function deliverRequest(
    saved: NodeCommand,
    deadline: number,
    reconcile: boolean,
    trace: import('@baton/telemetry').TraceContext | undefined,
  ): Promise<ThreadCommandResult> {
    const req = saved.request
    const config = req.open_config ?? (await io(ledger.worker(req.thread_id!)))?.config
    if (!config) throw new CommandDeliveryUncertain()
    if (!['thread_stop', 'thread_withdraw', 'thread_settings'].includes(req.type))
      await authorizeDirectory(options.dataDirectory, config.working_directory)
    if (performance.now() >= deadline) throw new CommandDeliveryUncertain()
    const readiness = await recovery.ensure(req.thread_id!)
    if (readiness === 'lost') throw new WorkerHistoryUnavailable()
    if (readiness === 'runtime_mode_conflict') throw new AdmissionRejected('runtime_mode_conflict')
    if (readiness === 'retry') {
      if (!(await upgradePaused(options.dataDirectory))) throw new CommandDeliveryUncertain()
      // 排空期间仅启动受门禁限制的 Worker，接收队列和停止/撤回，不恢复原生会话。
      await host.ensureWorker(req.thread_id!)
    }
    const ipcDeadline = Math.min(deadline, performance.now() + 1000)
    const request = (value: WorkerRequest) => {
      const remaining = Math.floor(ipcDeadline - performance.now())
      if (remaining <= 0) throw new CommandDeliveryUncertain()
      return host.request(
        req.thread_id!,
        { ...value, ...(trace ? { trace_context: trace } : {}) },
        { timeoutMs: remaining },
      )
    }
    let reply: WorkerIPCMessage | undefined
    if (reconcile) {
      const status = await request({
        type: 'thread_command_status',
        ok: false,
        command_id: saved.id,
        thread_id: req.thread_id!,
        storage_generation: config.storage_generation,
      })
      if (status.ok) reply = status
      else if (
        status.code !== 'command_not_found' &&
        !(req.type === 'thread_open' && status.code === 'identity_mismatch')
      )
        throw new CommandDeliveryUncertain()
    }
    if (!reply) {
      if (req.type === 'thread_open' || req.type === 'thread_resume') {
        const reported = options.capability()
        const agents: readonly RuntimeAgent[] = Array.isArray(reported) ? reported : [reported as RuntimeAgent]
        const agent = agents.find((value) => value.agent_type === config.agent_type)
        const mode = agent?.runtime_modes?.find((value) => value.id === config.runtime_mode)
        const code =
          !agent ||
          agent.status !== 'available' ||
          !agent.capabilities[req.type === 'thread_open' ? 'create' : 'resume']
            ? 'agent_unavailable'
            : !mode
              ? 'runtime_mode_unsupported'
              : !mode.available
                ? 'runtime_mode_unavailable'
                : undefined
        if (code) {
          const result: ThreadCommandResult = {
            type: 'thread.command_result',
            thread_id: req.thread_id!,
            ok: false,
            code,
            ...(code === 'runtime_mode_unavailable' && mode?.reason ? { reason: mode.reason } : {}),
            storage_generation: config.storage_generation,
          }
          await io(ledger.received(saved.id, result))
          return result
        }
      }
      if (req.type === 'thread_open') await io(ledger.markWorkerOpenAttempt(config.thread_id))
      reply = await request(req)
    }
    if (reply.ok) {
      const accepted = Schema.decodeUnknownSync(WorkerCommandResult)(reply)
      if (
        accepted.receipt.command_id !== saved.id ||
        accepted.receipt.thread_id !== req.thread_id ||
        accepted.receipt.storage_generation !== config.storage_generation ||
        accepted.receipt.action !== req.type.slice(7)
      )
        throw new CommandDeliveryUncertain()
    } else if (!reply.code || !workerRejections.has(reply.code)) throw new CommandDeliveryUncertain()
    const result: ThreadCommandResult = {
      type: 'thread.command_result',
      thread_id: req.thread_id!,
      ok: reply.ok,
      storage_generation: config.storage_generation,
      ...(reply.ok ? {} : { code: reply.code ?? 'worker_rejected' }),
    }
    await io(ledger.received(saved.id, result, reply.receipt))
    return result
  }
  async function execute(id: string, cmd: ThreadCommand): Promise<ThreadCommandResult> {
    if ((await readUpgradeState(options.dataDirectory))?.phase === 'ready')
      return { type: 'thread.command_result', thread_id: cmd.thread_id, ok: false, code: 'node_upgrading' }
    // All stages share the command's outer budget; Worker launch owns at most 3 seconds.
    const deadline = performance.now() + 4500
    if (cmd.action === 'check_activity') {
      if (!cmd.activity_check_seq || !cmd.storage_generation) throw new AdmissionRejected('invalid_request')
      const reply = await host.request(
        cmd.thread_id,
        { type: 'status', ok: false, activity_check_seq: cmd.activity_check_seq },
        { timeoutMs: 1000 },
      )
      const valid =
        reply.ok &&
        reply.worker_ready &&
        reply.agent_ready &&
        reply.session_id === cmd.thread_id &&
        reply.storage_generation === cmd.storage_generation &&
        reply.activity_check_seq === cmd.activity_check_seq &&
        reply.active_turn !== undefined
      return {
        type: 'thread.command_result',
        thread_id: cmd.thread_id,
        activity_check_seq: cmd.activity_check_seq,
        storage_generation: cmd.storage_generation,
        ok: !!valid,
        ...(valid ? { active_turn: reply.active_turn } : { code: 'activity_not_verified' }),
      }
    }
    const hash = commandHash(cmd)
    let saved = await io(ledger.command(id))
    if (saved && saved.hash !== hash)
      return { type: 'thread.command_result', thread_id: cmd.thread_id, ok: false, code: 'command_content_mismatch' }
    if (saved?.result) return saved.result
    const reconcile = saved !== undefined
    if (!saved) {
      const previous = await io(ledger.worker(cmd.thread_id))
      let request: WorkerRequest
      if (cmd.action === 'open') {
        const agentType = cmd.agent_type
        if (agentType === undefined) throw new AdmissionRejected('agent_unavailable')
        const reported = options.capability()
        const capabilities: readonly RuntimeAgent[] = Array.isArray(reported) ? reported : [reported as RuntimeAgent]
        const capability = capabilities.find((agent) => agent.agent_type === agentType)
        if (previous) throw new AdmissionRejected('thread_already_exists')
        if (!capability || capability.status !== 'available' || !capability.capabilities.create)
          throw new AdmissionRejected('agent_unavailable')
        if (!cmd.runtime_mode) throw new AdmissionRejected('runtime_mode_unsupported')
        const mode = capability.runtime_modes?.find((entry) => entry.id === cmd.runtime_mode)
        if (!mode) throw new AdmissionRejected('runtime_mode_unsupported')
        if (!mode.available) throw new AdmissionRejected('runtime_mode_unavailable', mode.reason)
        if (!cmd.working_directory) throw new AdmissionRejected('invalid_working_directory')
        let cwd: string
        try {
          cwd = await authorizeDirectory(options.dataDirectory, cmd.working_directory)
        } catch {
          throw new AdmissionRejected('working_directory_forbidden')
        }
        const generation = cmd.storage_generation ?? randomUUID()
        const paths = workerPaths(options.dataDirectory, cmd.thread_id)
        const model = cmd.model ?? capability.default_model
        request = {
          type: 'thread_open',
          ok: false,
          command_id: id,
          thread_id: cmd.thread_id,
          storage_generation: generation,
          open_config: {
            thread_id: cmd.thread_id,
            node_id: options.identity.node_id,
            storage_generation: generation,
            agent_type: agentType,
            runtime_mode: cmd.runtime_mode,
            ...(cmd.project_id ? { project_id: cmd.project_id } : {}),
            ...(cmd.origin_conversation_id ? { origin_conversation_id: cmd.origin_conversation_id } : {}),
            ...(cmd.origin_tool_call_id ? { origin_tool_call_id: cmd.origin_tool_call_id } : {}),
            working_directory: cwd,
            execution_timeout_seconds: cmd.execution_timeout_seconds ?? 7200,
            ...(model ? { model } : {}),
            adapter_config: {
              state_path: join(paths.threadDirectory, 'native.json'),
            },
          },
        }
      } else {
        if (!previous) throw new AdmissionRejected('thread_not_found')
        if (cmd.action === 'resume' && cmd.runtime_mode !== previous.config.runtime_mode)
          throw new AdmissionRejected('runtime_mode_conflict')
        if (cmd.action === 'resume') {
          const reported = options.capability()
          const capabilities: readonly RuntimeAgent[] = Array.isArray(reported) ? reported : [reported as RuntimeAgent]
          const agent = capabilities.find((entry) => entry.agent_type === previous.config.agent_type)
          if (!agent || agent.status !== 'available' || !agent.capabilities.resume)
            throw new AdmissionRejected('agent_unavailable')
          const mode = agent.runtime_modes?.find((entry) => entry.id === previous.config.runtime_mode)
          if (!mode) throw new AdmissionRejected('runtime_mode_unsupported')
          if (!mode.available) throw new AdmissionRejected('runtime_mode_unavailable', mode.reason)
        }
        if (cmd.storage_generation && cmd.storage_generation !== previous.config.storage_generation)
          throw new AdmissionRejected('storage_generation_mismatch')
        request = decodeRequest({
          type: `thread_${cmd.action}`,
          ok: false,
          command_id: id,
          thread_id: cmd.thread_id,
          storage_generation: previous.config.storage_generation,
          ...(cmd.client_message_id ? { client_message_id: cmd.client_message_id } : {}),
          ...(cmd.content !== undefined ? { payload: cmd.content } : {}),
          ...(cmd.mode ? { mode: cmd.mode } : {}),
          ...(cmd.model ? { model: cmd.model } : {}),
          ...(cmd.thinking ? { thinking: cmd.thinking } : {}),
          ...(cmd.answer ? { answer: cmd.answer } : {}),
          ...(cmd.execution_timeout_seconds !== undefined
            ? { execution_timeout_seconds: cmd.execution_timeout_seconds }
            : {}),
        })
      }
      request = { ...request, ...(cmd.trace_context ? { trace_context: cmd.trace_context } : {}) }
      saved = await io(ledger.prepare({ id, hash, request: decodeRequest(request) }))
    }
    return deliver(saved, deadline, reconcile)
  }
  return {
    command(id: string, cmd: ThreadCommand): Promise<ThreadCommandResult> {
      const previous = inFlight.get(id)
      if (previous)
        return previous.hash === commandHash(cmd)
          ? previous.result
          : Promise.resolve({
              type: 'thread.command_result',
              thread_id: cmd.thread_id,
              ok: false,
              code: 'command_content_mismatch',
            })
      const result = tracePromise(
        options.tracer,
        'baton.command.receive',
        cmd.trace_context,
        (trace) => execute(id, { ...cmd, ...(trace ? { trace_context: trace } : {}) }),
        {
          kind: 'consumer',
          attributes: { 'baton.command.id': id, 'baton.thread.id': cmd.thread_id, 'baton.command.action': cmd.action },
        },
      )
        .catch((error: unknown): ThreadCommandResult => {
          if (error instanceof DaemonStorageFailure || error instanceof WorkerHistoryUnavailable) throw error
          if (!(error instanceof AdmissionRejected)) throw new CommandDeliveryUncertain()
          return {
            type: 'thread.command_result',
            thread_id: cmd.thread_id,
            ok: false,
            code: error.code,
            ...(error.reason ? { reason: error.reason } : {}),
          }
        })
        .finally(() => inFlight.delete(id))
      inFlight.set(id, { hash: commandHash(cmd), result })
      return result
    },
    async discover(signal?: AbortSignal) {
      await recovery.recoverAll(signal)
    },
    async recover(signal?: AbortSignal) {
      await recovery.recoverAll(signal)
      for (const saved of await io(ledger.pendingCommands())) {
        if (signal?.aborted) return
        try {
          await deliver(saved, performance.now() + 4500, true)
        } catch (error) {
          if (error instanceof DaemonStorageFailure) throw error
        }
      }
    },
    async collectReports(signal?: AbortSignal) {
      await recovery.recoverAll(signal)
      for (const saved of await io(ledger.workers())) {
        if (signal?.aborted) return
        if (saved.history_unavailable) continue
        let reply: WorkerIPCMessage
        try {
          reply = await host.request(
            saved.threadId,
            { type: 'thread_pending', ok: false, after_worker_seq: 0 },
            { timeoutMs: 1000 },
          )
        } catch {
          continue
        }
        if (!reply.ok) continue
        for (const input of reply.thread_reports ?? []) {
          if (signal?.aborted) return
          const report = Schema.decodeUnknownSync(ThreadReport)(input)
          if (report.thread_id !== saved.threadId || report.storage_generation !== saved.config.storage_generation)
            throw new Error('Worker 报告身份不符')
          await io(ledger.ingest(report))
          // The node owns the durable report before the Worker can remove its pending copy.
          try {
            await host.request(
              saved.threadId,
              { type: 'thread_ack', ok: false, event_id: report.event_id, worker_seq: report.worker_seq },
              { timeoutMs: 1000 },
            )
          } catch {
            break
          }
        }
      }
    },
  }
}
