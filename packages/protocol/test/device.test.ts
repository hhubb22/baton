import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import {
  ControlToNodeBody,
  NodeBody,
  NodeStatus,
  NodeToControlBody,
  NodeUpgradeState,
  NodeUpgradeStateRequest,
  NodeUpgradeStateResult,
  RuntimeReport,
} from '../src/index.ts'

const state: NodeUpgradeState = {
  operation_id: '11111111-1111-4111-8111-111111111111',
  source_version: 'development',
  target_version: 'v1',
  phase: 'draining',
}

it('遥测消息只接受三种信号且受节点消息容量限制', () => {
  for (const signal of ['traces', 'logs', 'metrics']) {
    expect(Schema.is(NodeToControlBody)({ type: 'telemetry.export', signal, payload: { records: [] } })).toBe(true)
  }
  expect(Schema.is(NodeToControlBody)({ type: 'telemetry.export', signal: 'other', payload: {} })).toBe(false)
  expect(
    Schema.is(NodeToControlBody)({ type: 'telemetry.export', signal: 'logs', payload: 'x'.repeat(256 * 1024) }),
  ).toBe(false)
})

it('升级阶段消息在各自方向及完整联合中往返，公开字段不包含本地路径或失败原因', () => {
  for (const phase of ['draining', 'ready', 'migrating', 'syncing', 'completed', 'cancelled', 'failed'] as const) {
    const current = { ...state, phase }
    const request = { type: 'node.upgrade_state', ...current }
    const result = {
      type: 'node.upgrade_state_result',
      operation_id: state.operation_id,
      phase,
      ok: false,
      code: 'upgrade_conflict',
    }
    expect(Schema.decodeUnknownSync(NodeUpgradeState)(current)).toEqual(current)
    for (const schema of [NodeUpgradeStateRequest, NodeToControlBody, NodeBody]) {
      const decoded = Schema.decodeUnknownSync(schema)({
        ...request,
        target_path: '/private/package',
        reason: 'private diagnostic',
      })
      expect(Schema.encodeSync(schema)(decoded)).toEqual(request)
    }
    for (const schema of [NodeUpgradeStateResult, ControlToNodeBody, NodeBody]) {
      const decoded = Schema.decodeUnknownSync(schema)(result)
      expect(Schema.encodeSync(schema)(decoded)).toEqual(result)
      expect(Schema.is(schema)({ ...result, code: undefined })).toBe(false)
    }
    expect(Schema.is(NodeToControlBody)(result)).toBe(false)
    expect(Schema.is(ControlToNodeBody)(request)).toBe(false)
  }
})

it('升级状态约束 UUID、阶段及 256 字节非空版本', () => {
  const request = { type: 'node.upgrade_state', ...state }
  for (const patch of [
    { operation_id: 'operation' },
    { source_version: '' },
    { target_version: '' },
    { source_version: 'v'.repeat(257) },
    { target_version: '版'.repeat(86) },
    { target_version: 'v\0' },
    { phase: 'unknown' },
  ]) {
    expect(Schema.is(NodeUpgradeState)({ ...state, ...patch })).toBe(false)
    expect(Schema.is(NodeToControlBody)({ ...request, ...patch })).toBe(false)
  }
  expect(Schema.is(NodeUpgradeState)({ ...state, source_version: 'v'.repeat(256) })).toBe(true)
  expect(Schema.is(NodeUpgradeState)({ ...state, target_version: '版'.repeat(85) + 'v' })).toBe(true)
  const result = {
    type: 'node.upgrade_state_result',
    operation_id: state.operation_id,
    phase: 'ready',
    ok: true,
  }
  expect(Schema.decodeUnknownSync(NodeUpgradeStateResult)(result)).toEqual(result)
  for (const patch of [{ operation_id: 'operation' }, { phase: 'unknown' }, { ok: 1 }, { code: '\0' }]) {
    expect(Schema.is(ControlToNodeBody)({ ...result, ...patch })).toBe(false)
  }
})

it('RuntimeReport 能力与 NodeStatus 升级状态可省略，升级状态也可为 null', () => {
  const report: RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: [],
    repos: [],
  }
  expect(Schema.decodeUnknownSync(RuntimeReport)(report)).toEqual(report)
  expect(Schema.decodeUnknownSync(RuntimeReport)({ ...report, upgrade_protocol: 1 })).toEqual({
    ...report,
    upgrade_protocol: 1,
  })
  for (const upgrade_protocol of [0, 2, '1', null]) {
    expect(Schema.is(RuntimeReport)({ ...report, upgrade_protocol })).toBe(false)
  }
  const node: NodeStatus = {
    registered_at: '2026-10-24T00:00:00Z',
    runtime_report: report,
    runtime_report_version: 1,
    runtime_reported_at: null,
    user: '',
    id: state.operation_id,
    display_name: 'Offline',
    system: 'linux',
    capabilities: [],
    registration_seq: 1,
    online: false,
    last_contact_at: null,
    status_updated_at: null,
    synced: false,
    executable: false,
    revocation_status: '',
  }
  expect(Schema.decodeUnknownSync(NodeStatus)(node)).toEqual(node)
  for (const upgrade_state of [null, state]) {
    expect(Schema.decodeUnknownSync(NodeStatus)({ ...node, upgrade_state })).toEqual({ ...node, upgrade_state })
  }
  expect(Schema.is(NodeStatus)({ ...node, upgrade_state: { ...state, phase: 'unknown' } })).toBe(false)
})
