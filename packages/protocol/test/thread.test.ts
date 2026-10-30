import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import { Thread, ThreadSummary, ThreadView } from '../src/index.ts'

const thread = {
  id: '11111111-1111-4111-8111-111111111111',
  employee_id: '22222222-2222-4222-8222-222222222222',
  client_thread_id: 'client-thread',
  node_id: '33333333-3333-4333-8333-333333333333',
  agent_type: 'pi',
  runtime_mode: 'full-access',
  model: '',
  next_model: '',
  working_directory: '/workspace/项目',
  execution_timeout_seconds: 0,
  status: 'idle',
  status_reason: '',
  created_by: 'employee',
  storage_generation: 'generation',
  opened_at: '2026-10-24T12:34:56.123456789+08:00',
  archived_at: null,
  last_worker_seq: 0,
  version: 1,
  created_at: '2026-10-24T04:34:56.123456789Z',
  last_activity_at: '2026-10-24T04:34:56.123456789Z',
  node_online: false,
  node_synced: false,
  node_last_contact_at: null,
} satisfies Thread

const summary = { ...thread, title: '', stop_canceled: 0, current_turn: null }
const view = {
  ...thread,
  question_answers: [],
  pending_questions: [],
  resume_pending: false,
  current_turn: null,
  pending_messages: [],
  failed_messages: null,
}

it('Thread 派生对象往返保留时间精度、空值和可选字段省略', () => {
  const decodedSummary = Schema.decodeUnknownSync(ThreadSummary, { onExcessProperty: 'error' })(summary)
  expect(Schema.encodeSync(ThreadSummary)(decodedSummary)).toEqual(summary)
  const decodedView = Schema.decodeUnknownSync(ThreadView, { onExcessProperty: 'error' })(view)
  expect(Schema.encodeSync(ThreadView)(decodedView)).toEqual(view)
  expect(decodedView).not.toHaveProperty('project_id')
  expect(decodedView).not.toHaveProperty('retry_open_allowed')
})

it('Thread 及派生对象使用相同字段约束并容忍未知字段', () => {
  for (const schema of [Thread, ThreadSummary, ThreadView]) {
    const body = { ...summary, ...view, future_field: { enabled: true } }
    const decoded = Schema.decodeUnknownSync(schema)(body)
    expect(decoded).not.toHaveProperty('future_field')
    for (const patch of [
      { working_directory: '' },
      { working_directory: '项'.repeat(1366) },
      { model: 'm'.repeat(513) },
      { status: 'future_status' },
      { last_worker_seq: -1 },
      { version: Number.MAX_SAFE_INTEGER + 1 },
      { status_reason: '\0' },
    ]) {
      expect(Schema.is(schema)({ ...body, ...patch })).toBe(false)
    }
  }
})
