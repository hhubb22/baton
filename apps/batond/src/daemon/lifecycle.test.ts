import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { NodeIdentity, ThreadReport, WorkerOpen } from '@baton/protocol'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { coordinatorURL, relayURL } from './identity.ts'
import { contentHash, makeNodeLedger } from './ledger.ts'
import { reconnectDelay } from './transport.ts'

const temporary: string[] = []
const directory = async () => {
  const path = await makePrivateTempDirectory('bn-')
  temporary.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
export const identity = (): NodeIdentity => ({
  node_id: randomUUID(),
  employee_id: randomUUID(),
  display_name: 'Local node',
  system: 'macos',
  role: '',
  capabilities: [],
  coordinator_url: 'https://coordinator.invalid',
  registration_seq: 1,
  registered_at: new Date().toISOString(),
  credential: {
    id: randomUUID(),
    version: 1,
    token: 'server-issued-offline-credential',
  },
})

function open(directory: string): WorkerOpen {
  const thread = randomUUID(),
    generation = randomUUID()
  return {
    type: 'thread_open',
    ok: false,
    command_id: randomUUID(),
    thread_id: thread,
    storage_generation: generation,
    open_config: {
      thread_id: thread,
      node_id: randomUUID(),
      storage_generation: generation,
      agent_type: 'cursor',
      runtime_mode: 'full-access',
      working_directory: directory,
      execution_timeout_seconds: 60,
      adapter_config: {},
    },
  }
}

describe('node.db durable handoff', () => {
  it('retains command identity, receipt, Worker discovery and acknowledged report replay across restart', async () => {
    const path = await directory()
    const request = open(path)
    const report = (seq: number): ThreadReport => ({
      type: 'thread.report',
      thread_id: request.thread_id,
      event_id: randomUUID(),
      worker_seq: seq,
      storage_generation: request.storage_generation,
      kind: 'thread.opened',
    })
    const reports = [report(1), report(2), report(3)]
    const prepared = { id: request.command_id, hash: contentHash({ action: 'open', cwd: path }), request }
    const receipt = {
      command_id: request.command_id,
      thread_id: request.thread_id,
      storage_generation: request.storage_generation,
      action: 'open' as const,
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(path, 'node.db'))
          expect(yield* ledger.pragmas()).toEqual({ journal: 'wal', synchronous: 2 })
          yield* ledger.prepare(prepared)
          yield* ledger.received(
            prepared.id,
            {
              type: 'thread.command_result',
              thread_id: request.thread_id,
              ok: true,
              storage_generation: request.storage_generation,
            },
            receipt,
          )
          for (const r of reports) {
            yield* ledger.ingest(r)
            yield* ledger.ingest({ ...r, trace_context: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` } })
          }
          for (const r of reports) yield* ledger.acknowledge({ ...r, type: 'thread.report_result', ok: true })
          expect(yield* ledger.pendingReports()).toEqual([])
        }),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(path, 'node.db'))
          expect((yield* ledger.command(prepared.id))?.receipt).toEqual(receipt)
          expect((yield* ledger.workers())[0]).toEqual({
            threadId: request.thread_id,
            config: request.open_config,
            ready: true,
            startup_phase: 'open_attempted',
          })
          yield* ledger.acknowledge({
            type: 'thread.report_result',
            thread_id: request.thread_id,
            event_id: reports[2]!.event_id,
            worker_seq: 3,
            ok: false,
            expected_worker_seq: 2,
          })
          expect(yield* ledger.pendingReports()).toEqual(reports.slice(1))
          const collision = yield* ledger.prepare({ ...prepared, hash: 'changed' }).pipe(Effect.result)
          expect(collision._tag).toBe('Failure')
          const gap = yield* ledger.ingest(report(5)).pipe(Effect.result)
          expect(gap._tag).toBe('Failure')
          expect((yield* ledger.command(prepared.id))?.hash).toBe(prepared.hash)
        }),
      ),
    )
  })
})

describe('coordinator validation', () => {
  it('rejects insecure endpoints and bounds jitter', () => {
    for (const raw of ['http://local', 'https://user:secret@local', 'https://local/path', 'https://local/?secret=x'])
      expect(() => coordinatorURL(raw)).toThrow()
    expect(() => relayURL('ws://local')).toThrow()
    expect(relayURL('wss://local')).toBe('wss://local/v1/node')
    expect(reconnectDelay(0, () => 0)).toBe(1000)
    expect(reconnectDelay(2, () => 0.5)).toBe(4000)
    expect(reconnectDelay(100, () => 1)).toBe(30_000)
  })
})
