import { randomBytes } from 'node:crypto'
import { access, readdir, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Schema } from 'effect'
import {
  UUID,
  type ExecutionCommand,
  type ExecutionOutputRequest,
  type ExecutionOutputResult,
  type ExecutionReport,
  type ExecutionReportResult,
} from '@baton/protocol'
import { acquireProcessLock, processLockIsHeld, ProcessLockBusy } from '../platform/lock.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { spawnDetachedWorker } from '../platform/process.ts'
import { FullOutputStore } from '../worker/full-output.ts'
import { currentBatondCommand, type BatondCommand } from '../daemon/host.ts'
import { requestAuthenticated } from '../daemon/ipc.ts'
import { decodeRequest, decodeResponse, type ExecutionRequest } from './ipc.ts'
import { executionPaths } from './paths.ts'
import { readExecutionState, type ExecutionState } from './ledger.ts'

const terminal = (state: ExecutionState) =>
  state.reports.some(({ report }) =>
    ['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(report.status),
  )

export async function inspectExecutions(
  dataDirectory: string,
): Promise<readonly { id: string; state: ExecutionState }[]> {
  const paths = executionPaths(dataDirectory, '00000000-0000-4000-8000-000000000000')
  const entries = await readdir(`${paths.root}/executions`).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
  const result: { id: string; state: ExecutionState }[] = []
  for (const id of entries) {
    if (!Schema.is(UUID)(id)) continue
    try {
      const filename = executionPaths(dataDirectory, id).ledger
      await access(filename)
      const state = readExecutionState(filename)
      if (state) result.push({ id, state })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  return result
}

export function makeExecutionService(options: { dataDirectory: string; command?: BatondCommand }) {
  const command = options.command ?? currentBatondCommand()
  const request = async (id: string, input: ExecutionRequest) => {
    const paths = executionPaths(options.dataDirectory, id)
    const token = (await readPrivateFile(paths.token)).toString('utf8')
    return requestAuthenticated({
      endpoint: paths.endpoint,
      token,
      request: input,
      decodeRequest,
      decodeResponse,
      timeoutMs: 5000,
    })
  }
  const ensure = async (id: string) => {
    const paths = executionPaths(options.dataDirectory, id)
    await ensurePrivateDirectory(paths.root)
    await ensurePrivateDirectory(`${paths.root}/executions`)
    await ensurePrivateDirectory(paths.directory)
    await ensurePrivateDirectory(paths.ipcDirectory)
    const deadline = Date.now() + 10000
    const ready = async () =>
      request(id, { type: 'execution.poll' }).then(
        () => true,
        () => false,
      )
    if (await ready()) return
    while (Date.now() < deadline) {
      let release: (() => Promise<void>) | undefined
      try {
        release = await acquireProcessLock(paths.launchLock)
        if (await ready()) return
        if (!(await processLockIsHeld(paths.lock))) {
          try {
            await readPrivateFile(paths.token)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
            await writePrivateFileAtomic(paths.token, randomBytes(32).toString('hex'))
          }
          if (process.platform !== 'win32') await unlink(paths.endpoint).catch(() => {})
          await spawnDetachedWorker({
            file: command.executable,
            args: [...command.args, 'execution-worker', '--data-dir', paths.root, '--execution-id', id],
          })
        }
        while (Date.now() < deadline) {
          if (await ready()) return
          await delay(30)
        }
      } catch (error) {
        if (!(error instanceof ProcessLockBusy)) throw error
      } finally {
        await release?.()
      }
      await delay(30)
    }
    throw new Error('Execution Worker did not become ready')
  }
  return {
    async command(input: ExecutionCommand) {
      const existing = (await inspectExecutions(options.dataDirectory)).find(
        (entry) => entry.id === input.execution_id,
      )?.state
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
      await ensure(input.execution_id)
      const response = await request(input.execution_id, input)
      if (!response.result) throw new Error('Execution Worker returned no command result')
      return response.result
    },
    async recover() {
      for (const { id, state } of await inspectExecutions(options.dataDirectory)) {
        if (!terminal(state) || state.process) {
          await ensure(id)
          if (terminal(state) && state.process) await request(id, { type: 'execution.recover' })
        }
      }
    },
    async collectReports(): Promise<ExecutionReport[]> {
      const reports: ExecutionReport[] = []
      for (const { id, state } of await inspectExecutions(options.dataDirectory)) {
        if (!terminal(state) || state.process) {
          await ensure(id)
          if (terminal(state) && state.process) await request(id, { type: 'execution.recover' })
        }
        const current = readExecutionState(executionPaths(options.dataDirectory, id).ledger)
        if (current) reports.push(...current.reports.filter((entry) => !entry.acked).map((entry) => entry.report))
      }
      return reports
    },
    async ack(report: ExecutionReportResult) {
      const state = (await inspectExecutions(options.dataDirectory)).find(
        (entry) => entry.id === report.execution_id,
      )?.state
      if (
        !report.ok ||
        !state ||
        state.reports.some(
          (entry) => entry.report.seq === report.seq && entry.report.event_id === report.event_id && entry.acked,
        )
      )
        return
      await ensure(report.execution_id)
      await request(report.execution_id, report)
    },
    async output(input: ExecutionOutputRequest): Promise<ExecutionOutputResult> {
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
  }
}
