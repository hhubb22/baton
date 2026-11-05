import { join } from 'node:path'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { Effect, Exit, Scope } from 'effect'
import {
  type ExecutionCommand,
  type ExecutionOutputRequest,
  type ExecutionOutputResult,
  type ExecutionReport,
  type ExecutionReportResult,
} from '@baton/protocol'
import { startProcessWatchdog, type ProcessWatchdog } from '../platform/process.ts'
import { FullOutputStore } from '../worker/full-output.ts'
import { currentBatondCommand, type BatondCommand } from '../daemon/host.ts'
import { InProcessExecution } from './in-process.ts'
import { openExecutionLedger, readExecutionStates, type ExecutionState } from './node-ledger.ts'
import { executionPaths } from './paths.ts'

const terminal = (state: ExecutionState) =>
  state.reports.some(({ report }) =>
    ['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(report.status),
  )

export function makeExecutionService(options: {
  dataDirectory: string
  watchdogCommand?: BatondCommand
  excludedIds?: ReadonlySet<string>
  watchdog?: ProcessWatchdog
}) {
  const nodeDbPath = join(options.dataDirectory, 'node.db')
  const machines = new Map<string, Promise<{ machine: InProcessExecution; scope: Scope.Closeable }>>()
  let watchdog = options.watchdog ? Promise.resolve(options.watchdog) : undefined
  const ensureWatchdog = async () => {
    if (process.platform === 'win32') return undefined
    const command = options.watchdogCommand ?? currentBatondCommand()
    return (watchdog ??= startProcessWatchdog({ file: command.executable, args: [...command.args, 'watchdog'] }))
  }

  const load = async (id: string): Promise<{ machine: InProcessExecution; scope: Scope.Closeable } | undefined> => {
    if (options.excludedIds?.has(id)) return undefined
    await ensurePrivateDirectory(options.dataDirectory)
    await ensurePrivateDirectory(join(options.dataDirectory, 'executions'))
    await ensurePrivateDirectory(executionPaths(options.dataDirectory, id).directory)
    const existing = readExecutionStates(nodeDbPath).find((entry) => entry.id === id)
    const initial = existing?.state ?? { intent: false, reports: [] }
    const runningWatchdog = await ensureWatchdog()
    const scope = await Effect.runPromise(Scope.make())
    try {
      const ledger = await Effect.runPromise(
        openExecutionLedger(nodeDbPath, id).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      const machine = new InProcessExecution(options.dataDirectory, id, { save: ledger.save }, initial, runningWatchdog)
      await machine.initialize()
      return { machine, scope }
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(cause)))
      throw cause
    }
  }

  const ensure = (id: string) => {
    const existing = machines.get(id)
    if (existing) return existing
    const created = load(id).then((value) => {
      if (!value) throw new Error('Execution is excluded from this binding')
      return value
    })
    machines.set(id, created)
    void created.catch(() => machines.delete(id))
    return created
  }

  return {
    async command(input: ExecutionCommand) {
      if (options.excludedIds?.has(input.execution_id))
        return {
          type: 'execution.command_result' as const,
          execution_id: input.execution_id,
          storage_generation: input.storage_generation,
          ok: false,
          code: 'binding_mismatch',
        }
      const existing = readExecutionStates(nodeDbPath).find((entry) => entry.id === input.execution_id)?.state
      if (existing && terminal(existing)) {
        const original = existing.command ?? existing.stopped
        const sameGeneration = original?.storage_generation === input.storage_generation
        const ok =
          sameGeneration &&
          (input.action === 'stop' ||
            (!existing.command && !!existing.stopped) ||
            JSON.stringify(existing.command) === JSON.stringify(input))
        return {
          type: 'execution.command_result' as const,
          execution_id: input.execution_id,
          storage_generation: input.storage_generation,
          ok,
          ...(!ok
            ? {
                code: sameGeneration
                  ? existing.stopped && !existing.command
                    ? 'already_stopped'
                    : 'command_conflict'
                  : 'identity_mismatch',
              }
            : {}),
        }
      }
      const { machine } = await ensure(input.execution_id)
      const response = await machine.handle(input)
      if (!response.result) throw new Error('Execution state machine returned no command result')
      return response.result
    },
    async recover() {
      for (const { id, state } of readExecutionStates(nodeDbPath)) {
        if (options.excludedIds?.has(id)) continue
        if (!terminal(state) || state.process) await ensure(id)
      }
    },
    async collectReports(): Promise<ExecutionReport[]> {
      const reports: ExecutionReport[] = []
      for (const { id, state } of readExecutionStates(nodeDbPath)) {
        if (options.excludedIds?.has(id)) continue
        if (!terminal(state) || state.process) {
          const { machine } = await ensure(id)
          if (terminal(machine.state) && machine.state.process) await machine.handle({ type: 'execution.recover' })
        }
        const current = readExecutionStates(nodeDbPath).find((entry) => entry.id === id)?.state
        if (current) reports.push(...current.reports.filter((entry) => !entry.acked).map((entry) => entry.report))
      }
      return reports
    },
    async ack(report: ExecutionReportResult) {
      if (options.excludedIds?.has(report.execution_id)) return
      const state = readExecutionStates(nodeDbPath).find((entry) => entry.id === report.execution_id)?.state
      if (!state) return
      if (
        !report.ok ||
        state.reports.some(
          (entry) => entry.report.seq === report.seq && entry.report.event_id === report.event_id && entry.acked,
        )
      )
        return
      const { machine } = await ensure(report.execution_id)
      await machine.ack(report)
    },
    async output(input: ExecutionOutputRequest): Promise<ExecutionOutputResult> {
      if (options.excludedIds?.has(input.execution_id))
        return {
          type: 'execution.output_result',
          operation_id: input.operation_id,
          execution_id: input.execution_id,
          ok: false,
          code: 'binding_mismatch',
        }
      const paths = executionPaths(options.dataDirectory, input.execution_id)
      const page = await new FullOutputStore(paths.directory).read({
        type: 'session.request',
        operation_id: input.operation_id,
        session_id: input.execution_id,
        action: 'full_output',
        output_id: input.output_id,
        storage_generation: input.storage_generation,
        cursor: String(input.offset ?? 0),
      })
      return {
        type: 'execution.output_result',
        operation_id: input.operation_id,
        execution_id: input.execution_id,
        ok: page.ok,
        ...(page.code ? { code: page.code } : {}),
        ...(page.full_output ? { full_output: page.full_output } : {}),
      }
    },
    async close() {
      await Promise.allSettled(
        [...machines.values()].map(async (entry) => {
          const value = await entry.catch(() => undefined)
          if (value) {
            await value.machine.close()
            await Effect.runPromise(Scope.close(value.scope, Exit.void))
          }
        }),
      )
      const started = watchdog
      watchdog = undefined
      await started?.then((value) => value.close()).catch(() => undefined)
    },
  }
}
