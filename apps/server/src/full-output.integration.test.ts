import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import type { RuntimeReport, ThreadReport, FullOutputReference } from '@baton/protocol'
import { withTestDatabase, seedNode } from './testing/database.ts'
import * as Threads from './threads/index.ts'
import { readThreadOutput } from './full-output.ts'
import type { Gateway } from './gateway.ts'

it('preserves full-output references through center clipping and forwards reads only for the owning employee', () =>
  withTestDatabase(async ({ run }) => {
    const report: RuntimeReport = {
      exec: { enabled: false, shell: '/bin/sh' },
      roots: [{ root_id: 'root', path: '/workspace' }],
      repos: [],
      agents: [
        {
          agent_type: 'cursor',
          version: 'local',
          status: 'available',
          models: [],
          default_model: '',
          runtime_modes: [{ id: 'full-access', available: true }],
          default_runtime_mode: 'full-access',
          capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
        },
      ],
    }
    const node = await seedNode(run, { report })
    const input = { client_message_id: randomUUID(), content: 'read long output' }
    const { thread } = await run(
      Threads.create(node.employeeId, {
        client_thread_id: randomUUID(),
        node_id: node.nodeId,
        agent_type: 'cursor',
        working_directory: '/workspace',
        message: input,
      }),
    )
    const command = (await run(Threads.claimCommands())).find(
      (entry) => entry.body.thread_id === thread.id && entry.body.action === 'open',
    )
    if (!command) throw new Error('Expected an open command')
    await run(
      Threads.processReceipt(node.source, command.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'local-generation',
      }),
    )
    const emit = (worker_seq: number, kind: ThreadReport['kind'], extra: Partial<ThreadReport> = {}) =>
      run(
        Threads.processReport(node.source, {
          type: 'thread.report',
          event_id: randomUUID(),
          thread_id: thread.id,
          storage_generation: 'local-generation',
          worker_seq,
          kind,
          ...extra,
        }),
      )
    await emit(1, 'thread.opened', { native_session_id: 'native-local' })
    await emit(2, 'turn.started', { worker_turn_seq: 1, client_message_id: input.client_message_id })
    const original = 'HEAD' + 'middle🙂'.repeat(10000) + 'TAIL'
    const reference: FullOutputReference = {
      id: randomUUID(),
      storage_generation: 'local-generation',
      total_bytes: Buffer.byteLength(original),
      expires_at: '2099-01-01T00:00:00.000Z',
    }
    await emit(3, 'reply', { worker_turn_seq: 1, content: original, metadata: { full_output: reference } })
    const timeline = await run(Threads.timeline(node.employeeId, thread.id, { limit: '100' }))
    const reply = timeline.events?.find((event) => event.kind === 'reply')
    expect(reply?.payload).toMatchObject({ truncated: true, metadata: { full_output: reference } })
    const saved = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          content: string
          metadata: unknown
        }>`SELECT content,metadata FROM thread_replies WHERE thread_id=${thread.id}`
      }),
    )
    expect(saved[0]?.metadata).toEqual({ full_output: reference })
    expect(Buffer.byteLength(saved[0]?.content ?? '')).toBeLessThanOrEqual(32768)
    let reads = 0
    const gateway: Pick<Gateway, 'request'> = {
      request: async (nodeId, employeeId, body) => {
        reads++
        expect(nodeId).toBe(node.nodeId)
        expect(employeeId).toBe(node.employeeId)
        expect(body).toMatchObject({
          action: 'full_output',
          output_id: reference.id,
          storage_generation: reference.storage_generation,
          cursor: '12288',
        })
        return {
          type: 'session.result',
          session_id: body.session_id,
          operation_id: body.operation_id,
          ok: true,
          gap: false,
          cursor: '24576',
          full_output: {
            output_id: reference.id,
            storage_generation: reference.storage_generation,
            offset: 12288,
            next_offset: 24576,
            total_bytes: reference.total_bytes,
            expires_at: reference.expires_at,
            encoding: 'base64',
            done: false,
            data: Buffer.from(original).subarray(12288, 24576).toString('base64'),
          },
        }
      },
    }
    const query = {
      action: 'full_output',
      output_id: reference.id,
      storage_generation: reference.storage_generation,
      cursor: '12288',
    }
    const result = await run(
      readThreadOutput({ gateway: () => gateway }, node.employeeId, thread.id, {
        ...query,
        action: 'full_output',
      }),
    )
    expect(Buffer.from(result.full_output?.data ?? '', 'base64')).toEqual(Buffer.from(original).subarray(12288, 24576))
    await expect(
      run(
        readThreadOutput({ gateway: () => gateway }, randomUUID(), thread.id, {
          ...query,
          action: 'full_output',
        }),
      ),
    ).rejects.toMatchObject({ status: 404 })
    expect(reads).toBe(1)
  }))
