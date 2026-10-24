import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import * as Protocol from '../src/index.ts'

type Sample = { schema: string; name: string; value: Record<string, unknown> }
const readCases = (file: string): Sample[] =>
  (JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8')) as { cases: Sample[] }).cases
const go = readCases('go-http-node.json')
const worker = readCases('go-worker.json')
const migration = readCases('go-migration.json')
const sample = (cases: Sample[], schema: string, name: string): Record<string, unknown> => {
  const found = cases.find((item) => item.schema === schema && item.name === name)
  if (!found) throw new Error(`缺少样例 ${schema}.${name}`)
  return found.value
}

const frameCases: Array<[string, Schema.Codec<unknown>, Record<string, unknown>]> = [
  ['Frame', Protocol.Frame, sample(go, 'Frame', 'heartbeat')],
  ['AuthFrame', Protocol.AuthFrame, sample(go, 'Frame', 'auth')],
  ['AuthResultFrame', Protocol.AuthResultFrame, sample(go, 'Frame', 'auth_result')],
  ['HeartbeatFrame', Protocol.HeartbeatFrame, sample(go, 'Frame', 'heartbeat')],
  ['EnvelopeFrame', Protocol.EnvelopeFrame, sample(go, 'Frame', 'envelope')],
  ['ErrorFrame', Protocol.ErrorFrame, sample(go, 'Frame', 'error')],
  ['NodeFrame', Protocol.NodeFrame, sample(go, 'Frame', 'heartbeat')],
]
const workerCases: Array<[string, Schema.Codec<unknown>, Record<string, unknown>]> = [
  ['WorkerIPCMessage', Protocol.WorkerIPCMessage, sample(worker, 'WorkerIPCMessage', 'status')],
  ['WorkerAuth', Protocol.WorkerAuth, sample(worker, 'WorkerIPCMessage', 'auth')],
  ['WorkerResult', Protocol.WorkerResult, sample(worker, 'WorkerIPCMessage', 'result.auth')],
  ['WorkerStatusResult', Protocol.WorkerStatusResult, sample(worker, 'WorkerIPCMessage', 'result.agent_starting')],
  ['WorkerCommandResult', Protocol.WorkerCommandResult, sample(migration, 'WorkerCommandResult', 'open.accepted')],
  ['WorkerStatus', Protocol.WorkerStatus, sample(worker, 'WorkerIPCMessage', 'status')],
  ['WorkerOpen', Protocol.WorkerOpen, sample(migration, 'WorkerRequest', 'open')],
  ['WorkerMessage', Protocol.WorkerMessage, sample(migration, 'WorkerRequest', 'message')],
  ['WorkerWithdraw', Protocol.WorkerWithdraw, sample(migration, 'WorkerRequest', 'withdraw')],
  ['WorkerResume', Protocol.WorkerResume, sample(migration, 'WorkerRequest', 'resume')],
  ['WorkerStop', Protocol.WorkerStop, sample(migration, 'WorkerRequest', 'stop')],
  ['WorkerCommandStatusQuery', Protocol.WorkerCommandStatusQuery, sample(migration, 'WorkerRequest', 'query')],
  ['WorkerPending', Protocol.WorkerPending, sample(worker, 'WorkerIPCMessage', 'thread_pending')],
  ['WorkerAck', Protocol.WorkerAck, sample(worker, 'WorkerIPCMessage', 'thread_ack')],
  ['WorkerSessionRequest', Protocol.WorkerSessionRequest, sample(worker, 'WorkerIPCMessage', 'session_request')],
  ['WorkerNativeHistory', Protocol.WorkerNativeHistory, sample(worker, 'WorkerIPCMessage', 'native_history')],
  ['WorkerRequest', Protocol.WorkerRequest, sample(migration, 'WorkerRequest', 'open')],
]

describe('派生协议保留整体校验', () => {
  for (const [name, codec, value] of frameCases) {
    it(`${name} 保留 Frame 的容量限制`, () => {
      expect(Schema.is(codec)(value)).toBe(true)
      expect(Schema.is(codec)({ ...value, message: 'x'.repeat(300000) })).toBe(false)
    })
  }
  for (const [name, codec, value] of workerCases) {
    it(`${name} 保留 IPC 容量与 ready 关系限制`, () => {
      expect(Schema.is(codec)(value)).toBe(true)
      expect(Schema.is(codec)({ ...value, history: { data: 'x'.repeat(300000) } })).toBe(false)
      expect(Schema.is(codec)({ ...value, worker_ready: false, agent_ready: true })).toBe(false)
    })
  }
  it('IPC 的 256 KiB 边界按完整 JSON 计量', () => {
    const base = { type: 'status', ok: false, history: { data: '' } }
    const overhead = Buffer.byteLength(JSON.stringify(base))
    const exact = { ...base, history: { data: 'x'.repeat(Protocol.MaxMessageBytes - overhead) } }
    expect(Schema.is(Protocol.WorkerStatus)(exact)).toBe(true)
    expect(Schema.is(Protocol.WorkerStatus)({ ...exact, history: { data: exact.history.data + 'x' } })).toBe(false)
  })
  it('CommandCompleted 继续验证完成报告身份字段', () => {
    const value = sample(migration, 'CommandCompleted', 'completion_before_ack')
    expect(Schema.is(Protocol.CommandCompleted)(value)).toBe(true)
    expect(Schema.is(Protocol.CommandCompleted)({ ...value, command_id: undefined })).toBe(false)
    expect(Schema.is(Protocol.CommandCompleted)({ ...value, storage_generation: '' })).toBe(false)
  })
  it('open 回执和历史结果保留各自的跨字段限制', () => {
    expect(
      Schema.is(Protocol.ThreadOpenCommandResult)({
        type: 'thread.command_result',
        thread_id: '12345678-1234-4234-8234-123456789abc',
        ok: true,
      }),
    ).toBe(false)
    const history = sample(go, 'HistoryResult', 'history_loading')
    expect(Schema.is(Protocol.HistoryResult)(history)).toBe(true)
    expect(Schema.is(Protocol.HistoryResult)({ ...history, ok: true })).toBe(false)
  })
})
