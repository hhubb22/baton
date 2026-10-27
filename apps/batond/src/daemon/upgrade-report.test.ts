import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Schema } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type WebSocket from 'ws'
import { Envelope, NodeToControlBody, type NodeUpgradeStateRequest } from '@baton/protocol'
import { setupDaemon } from '../testing/daemon.ts'
import { saveUpgradeState } from './upgrade.ts'
import { webSocketText } from './transport.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function control(socket: WebSocket, body: unknown, correlation: string) {
  socket.send(
    JSON.stringify({
      kind: 'envelope',
      envelope: {
        version: 1,
        message_id: randomUUID(),
        route: { to: 'node' },
        priority: 'control',
        source: { kind: 'control' },
        correlation_id: correlation,
        body,
      },
    }),
  )
}

it.each(['ready', 'failed'] as const)(
  '%s 受限连接无业务数据库时重投丢失或不匹配的 ACK，确认后停投并在重连时重报',
  async (phase) => {
    const { path, wss, start } = await setupDaemon(cleanup)
    const state = {
      operation_id: randomUUID(),
      source_version: 'development',
      target_version: 'v1',
      phase,
    }
    await saveUpgradeState(path, {
      ...state,
      target_path: join(path, 'private-package'),
      reason: 'private failure diagnostic',
    })
    const deliveries: Array<{ connection: number; id: string; body: NodeUpgradeStateRequest }> = []
    let connections = 0
    let reports = 0
    let current: WebSocket | undefined
    wss.on('connection', (socket) => {
      const connection = ++connections
      current = socket
      socket.on('message', (bytes) => {
        const raw = webSocketText(bytes)
        const frame = JSON.parse(raw)
        if (frame.kind === 'auth') socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
        if (frame.kind !== 'envelope') return
        const env = Schema.decodeUnknownSync(Envelope)(frame.envelope)
        const body = Schema.decodeUnknownSync(NodeToControlBody)(env.body)
        if (body.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        if (body.type === 'node.runtime_report') {
          expect(body.report.upgrade_protocol).toBe(1)
          expect(body.report.exec.enabled).toBe(false)
          reports++
          control(socket, { type: 'node.runtime_report_result', ok: true }, env.message_id)
        }
        if (body.type !== 'node.upgrade_state') return
        expect(raw).not.toContain('target_path')
        expect(raw).not.toContain('private-package')
        expect(raw).not.toContain('private failure diagnostic')
        deliveries.push({ connection, id: env.message_id, body })
        const ack = { type: 'node.upgrade_state_result', operation_id: state.operation_id, phase, ok: true }
        if (connection > 1) {
          control(socket, ack, env.message_id)
          return
        }
        // 首次丢 ACK；随后逐项核实关联 ID、操作、阶段和成功标记。
        switch (deliveries.length) {
          case 1:
            break
          case 2:
            control(socket, ack, randomUUID())
            break
          case 3:
            control(socket, { ...ack, operation_id: randomUUID() }, env.message_id)
            break
          case 4:
            control(socket, { ...ack, phase: 'draining' }, env.message_id)
            break
          case 5:
            control(socket, { ...ack, ok: false, code: 'upgrade_conflict' }, env.message_id)
            break
          default:
            control(socket, ack, env.message_id)
        }
      })
    })
    const daemon = start()
    await vi.waitFor(() => expect(deliveries).toHaveLength(6), { timeout: 5000 })
    await delay(300)
    expect(deliveries).toHaveLength(6)
    expect(new Set(deliveries.map((entry) => entry.id)).size).toBe(1)
    for (const delivery of deliveries) expect(delivery.body).toEqual({ type: 'node.upgrade_state', ...state })
    expect(reports).toBeGreaterThan(0)
    expect(await readdir(path)).not.toContain('node.db')
    expect(await readdir(path)).not.toContain('project-runtime.db')

    current!.terminate()
    await vi.waitFor(() => expect(deliveries).toHaveLength(7), { timeout: 5000 })
    await delay(300)
    expect(connections).toBe(2)
    expect(deliveries).toHaveLength(7)
    expect(deliveries[6]).toMatchObject({ connection: 2, body: { type: 'node.upgrade_state', ...state } })
    expect(deliveries[6]!.id).not.toBe(deliveries[0]!.id)
    expect(await readdir(path)).not.toContain('node.db')
    expect(await readdir(path)).not.toContain('project-runtime.db')
    expect(daemon.failure()).toBeUndefined()
  },
)
