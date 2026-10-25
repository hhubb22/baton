import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import {
  CommandCompleted,
  ThreadCommand,
  ThreadOpenCommandResult,
  WorkerStatusResult,
  isCommandCompletionFor,
  isCommandReceiptFor,
} from '../src/index.ts'

const threadId = '11111111-1111-4111-8111-111111111111'
const commandId = '22222222-2222-4222-8222-222222222222'

it('完成报告往返保留身份，并只匹配原命令和认证节点', () => {
  const report = {
    type: 'thread.report',
    kind: 'command.completed',
    thread_id: threadId,
    command_id: commandId,
    event_id: '33333333-3333-4333-8333-333333333333',
    worker_seq: 1,
    storage_generation: 'generation',
    command_outcome: 'succeeded',
    reason: '',
  }
  const decoded = Schema.decodeUnknownSync(CommandCompleted, { onExcessProperty: 'error' })(report)
  expect(Schema.encodeSync(CommandCompleted)(decoded)).toEqual(report)
  const identity = { command_id: commandId, thread_id: threadId, storage_generation: 'generation', node_id: 'node' }
  expect(isCommandCompletionFor(identity, report, 'node')).toBe(true)
  expect(isCommandCompletionFor(identity, report, 'other-node')).toBe(false)
  expect(isCommandCompletionFor({ ...identity, command_id: threadId }, report, 'node')).toBe(false)
  expect(Schema.is(CommandCompleted)({ ...report, storage_generation: undefined })).toBe(false)
})

it('open 接收回执绑定 Thread，成功时要求存储代次', () => {
  const command = Schema.decodeUnknownSync(ThreadCommand)({
    type: 'thread.command',
    action: 'open',
    thread_id: threadId,
  })
  const result = { type: 'thread.command_result', thread_id: threadId, ok: true, storage_generation: 'generation' }
  const decoded = Schema.decodeUnknownSync(ThreadOpenCommandResult, { onExcessProperty: 'error' })(result)
  expect(Schema.encodeSync(ThreadOpenCommandResult)(decoded)).toEqual(result)
  expect(isCommandReceiptFor(command, result)).toBe(true)
  expect(isCommandReceiptFor(command, { ...result, thread_id: commandId })).toBe(false)
  expect(Schema.is(ThreadOpenCommandResult)({ ...result, storage_generation: undefined })).toBe(false)
})

it('Worker 状态分别报告接管与 Agent 就绪', () => {
  const status = { type: 'result', ok: true, worker_ready: true, agent_ready: false }
  const decoded = Schema.decodeUnknownSync(WorkerStatusResult, { onExcessProperty: 'error' })(status)
  expect(Schema.encodeSync(WorkerStatusResult)(decoded)).toEqual(status)
  expect(Schema.is(WorkerStatusResult)({ ...status, worker_ready: false, agent_ready: true })).toBe(false)
})
