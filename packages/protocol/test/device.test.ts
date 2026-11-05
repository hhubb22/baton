import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import { NodeStatus, RuntimeReport } from '../src/index.ts'

it('RuntimeReport 与 NodeStatus 只保留当前字段', () => {
  const report: RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: [],
    repos: [],
  }
  expect(Schema.decodeUnknownSync(RuntimeReport)(report)).toEqual(report)
  expect(Schema.decodeUnknownSync(RuntimeReport)({ ...report, legacy_runtime_field: 1 })).toEqual(report)
  const node: NodeStatus = {
    registered_at: '2026-10-24T00:00:00Z',
    runtime_report: report,
    runtime_report_version: 1,
    runtime_reported_at: null,
    user: '',
    id: '11111111-1111-4111-8111-111111111111',
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
  expect(Schema.decodeUnknownSync(NodeStatus)({ ...node, legacy_field: null })).toEqual(node)
})
