import { readFileSync } from 'node:fs'
import { Schema, SchemaAST } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import {
  CommandOutcome,
  Reason,
  RuntimeAgent,
  RuntimeReport,
  ThreadReport,
  WorkerAuth,
  WorkerIPCMessage,
  WorkerRequest,
  WorkerStatusResult,
  dtoSchemas,
  httpSchemas,
  CommandCompleted,
  ThreadOpenCommandResult,
  isCommandCompletionFor,
  isCommandReceiptFor,
  WorkerOpenConfig,
  WorkerAdapterConfig,
  WorkerCommandReceipt,
  WorkerCommandStatus,
  WorkerCommandResult,
} from '../src/index.ts'

type Shape = {
  kind: string
  ref?: string
  nullable?: boolean
  fields?: Array<{ name: string; optional: boolean; shape: Shape }>
  element?: Shape
}
type FixtureCase = { schema: string; name: string; value: unknown }
type GoDocument = {
  schemas: Record<string, { source: string; go_name: string; shape: Shape }>
  cases: FixtureCase[]
}
const go = JSON.parse(readFileSync(new URL('../fixtures/go-http-node.json', import.meta.url), 'utf8')) as GoDocument
const worker = JSON.parse(readFileSync(new URL('../fixtures/go-worker.json', import.meta.url), 'utf8')) as {
  fields: Array<{ name: string; optional: boolean; go_type: string }>
  cases: FixtureCase[]
}
const migration = JSON.parse(readFileSync(new URL('../fixtures/go-migration.json', import.meta.url), 'utf8')) as {
  cases: FixtureCase[]
  invalid: FixtureCase[]
}
const codecs: Record<string, Schema.Codec<unknown>> = {
  ...dtoSchemas,
  ...httpSchemas,
  WorkerIPCMessage,
  WorkerRequest,
  WorkerStatusResult,
  WorkerOpenConfig,
  WorkerAdapterConfig,
  WorkerCommandReceipt,
  WorkerCommandStatus,
  WorkerCommandResult,
  CommandCompleted,
  ThreadOpenCommandResult,
}
const additions: Record<string, string[]> = {
  RuntimeAgent: ['reason'],
  ThreadReport: ['command_id', 'command_outcome'],
  ThreadCommand: ['trace_context', 'project_id', 'origin_conversation_id', 'origin_tool_call_id'],
  ThreadCommandResult: ['storage_generation'],
}
const inputOptional = new Set([
  'ThreadMessageInput.model',
  'CreateBrowserThreadInput.node_id',
  'CreateBrowserThreadInput.model',
  'CreateProjectInput.goal',
  'PatchProjectInput.title',
  'PatchProjectInput.goal',
  'PatchProjectInput.status',
  'PatchProjectInput.provider',
  'PatchProjectInput.model',
  'RegisterNodeInput.role',
  'NodeSyncRequest.role',
])

function objectAST(codec: Schema.Codec<unknown>): SchemaAST.Objects {
  if (codec.ast._tag !== 'Objects') throw new Error(`协议结构变成了 ${codec.ast._tag}`)
  return codec.ast
}
function fixtureValue(name: string): Record<string, unknown> {
  const sample = go.cases.find((item) => item.schema === name && item.name === 'full')
  if (!sample) throw new Error(`缺少 Go 样例 ${name}`)
  return structuredClone(sample.value) as Record<string, unknown>
}

// 字段清单独立来自 Go 的反射；匿名结构另由 Go AST 比对 handler 原声明。
describe('Go JSON 字段与 Effect Schema', () => {
  it('每个 Go 类型均有独立的 Schema 与往返样例', () => {
    expect(Object.keys(dtoSchemas).sort()).toEqual(Object.keys(go.schemas).sort())
    expect(Object.keys(go.schemas)).toHaveLength(115)
    for (const name of Object.keys(go.schemas)) {
      expect(go.cases.filter((item) => item.schema === name).length).toBeGreaterThanOrEqual(2)
    }
  })
  for (const [name, descriptor] of Object.entries(go.schemas)) {
    it(`${name} 拒绝与 Go 字段种类不符的取值`, () => {
      const full = fixtureValue(name)
      for (const field of descriptor.shape.fields ?? []) {
        const bad: Record<string, unknown> = {
          string: 42,
          timestamp: 'not-a-timestamp',
          integer: '1',
          boolean: 'true',
          array: {},
          struct: 42,
          ref: 42,
        }
        if (!(field.shape.kind in bad)) continue
        expect(Schema.is(codecs[name])({ ...full, [field.name]: bad[field.shape.kind] }), field.name).toBe(false)
      }
    })
    it(`${name} 保留 ${descriptor.source}:${descriptor.go_name} 的字段与可选性`, () => {
      const ast = objectAST(codecs[name])
      const actual = new Map(ast.propertySignatures.map((field) => [String(field.name), field]))
      const fields = descriptor.shape.fields ?? []
      expect([...actual.keys()].sort()).toEqual(
        [...fields.map((field) => field.name), ...(additions[name] ?? [])].sort(),
      )
      for (const field of fields) {
        const property = actual.get(field.name)
        expect(property, field.name).toBeDefined()
        expect(SchemaAST.isOptional(property!.type), field.name).toBe(
          field.optional || inputOptional.has(`${name}.${field.name}`),
        )
      }
    })
  }
  it('Worker IPC 的全部 Go 字段和适配器新增字段均存在', () => {
    const fields = objectAST(WorkerIPCMessage).propertySignatures
    expect(fields.map((field) => String(field.name)).sort()).toEqual(
      [
        ...worker.fields.map((field) => field.name),
        'command_id',
        'storage_generation',
        'worker_ready',
        'agent_ready',
        'thread_id',
        'receipt',
        'command_status',
        'open_config',
        'trace_context',
      ].sort(),
    )
    for (const field of worker.fields) {
      expect(SchemaAST.isOptional(fields.find((item) => item.name === field.name)!.type)).toBe(field.optional)
    }
  })
})

// 严格模式使未声明字段直接失败，避免默认忽略未知字段掩盖 Schema 漏项。
describe('Go 导出样例往返', () => {
  for (const item of [
    ...go.cases.filter((item) => item.schema !== 'ThreadHistoryQuery'),
    ...worker.cases.filter((item) => item.name !== 'native_history'),
    ...migration.cases,
  ]) {
    it(`${item.schema} · ${item.name}`, () => {
      const codec = codecs[item.schema]
      expect(codec).toBeDefined()
      const decoded = Schema.decodeUnknownSync(codec, { onExcessProperty: 'error' })(item.value)
      const encoded = Schema.encodeSync(codec)(decoded)
      expect(encoded).toEqual(item.value)
    })
  }
  for (const item of migration.invalid) {
    it(`拒绝 ${item.schema} · ${item.name}`, () => {
      expect(codecs[item.schema]).toBeDefined()
      expect(() => Schema.decodeUnknownSync(codecs[item.schema], { onExcessProperty: 'error' })(item.value)).toThrow()
    })
  }
  it('异步命令通过正式 WorkerRequest 验证', () => {
    for (const item of worker.cases.filter((item) => item.name.endsWith('.command_id'))) {
      expect(Schema.encodeSync(WorkerRequest)(Schema.decodeUnknownSync(WorkerRequest)(item.value))).toEqual(item.value)
    }
  })
  it('Project 来源在 Thread 命令和 Worker 配置中保留', () => {
    const origin = {
      project_id: '98cb5d71-7e45-49c5-a6dc-e4d181516521',
      origin_conversation_id: 'a15294ed-09f1-46eb-81da-8ed1f705e282',
      origin_tool_call_id: 'exec-tool-1',
    }
    const command = { ...fixtureValue('ThreadCommand'), ...origin }
    const commandSchema = dtoSchemas.ThreadCommand
    expect(
      Schema.encodeSync(commandSchema)(Schema.decodeUnknownSync(commandSchema, { onExcessProperty: 'error' })(command)),
    ).toEqual(command)
    const config = {
      ...origin,
      thread_id: 'd7f96538-39af-4c55-be65-0135ef097d36',
      node_id: '390dbfed-3e99-4140-afde-accefe209326',
      storage_generation: 'shell-generation',
      agent_type: 'shell',
      working_directory: '/workspace',
      execution_timeout_seconds: 7200,
      adapter_config: {},
    }
    expect(
      Schema.encodeSync(WorkerOpenConfig)(
        Schema.decodeUnknownSync(WorkerOpenConfig, { onExcessProperty: 'error' })(config),
      ),
    ).toEqual(config)
    expect(Schema.is(commandSchema)({ ...command, project_id: 'invalid' })).toBe(false)
  })
  it('接收方忽略未知可选字段', () => {
    const original = fixtureValue('RuntimeAgent')
    expect(Schema.decodeUnknownSync(RuntimeAgent)({ ...original, future_capability: true })).toEqual(original)
  })
})

describe('协议边界', () => {
  it('拒绝无效的版本、判别字段和数值类型', () => {
    for (const [name, field, value] of [
      ['Envelope', 'version', 2],
      ['ThreadCommand', 'action', 'retry'],
      ['ThreadReport', 'kind', 'done'],
      ['ThreadReport', 'worker_seq', 0.5],
      ['ThreadReport', 'worker_seq', Number.MAX_SAFE_INTEGER + 1],
      ['SessionRequest', 'action', 'shell'],
      ['RuntimeAgent', 'status', 'maybe'],
    ] as const) {
      expect(Schema.is(codecs[name])({ ...fixtureValue(name), [field]: value }), `${name}.${field}`).toBe(false)
    }
  })
  it('reason 按 UTF-8 字节计量并拒绝控制字符', () => {
    expect(Schema.is(Reason)('x'.repeat(1024))).toBe(true)
    expect(Schema.is(Reason)('x'.repeat(1025))).toBe(false)
    for (const reason of [
      'Bearer fixture-not-a-real-credential',
      'api_key=fixture-not-real',
      'crsr_fixture-example-credential',
    ]) {
      expect(Schema.is(Reason)(reason)).toBe(false)
    }
    expect(Schema.is(Reason)('界'.repeat(341))).toBe(true)
    expect(Schema.is(Reason)('界'.repeat(342))).toBe(false)
    for (const reason of ['hello\0world', 'line\nraw', 'hello\u007f', 'hello\u0085']) {
      expect(Schema.is(Reason)(reason)).toBe(false)
    }
    expect(Schema.is(RuntimeAgent)({ ...fixtureValue('RuntimeAgent'), reason: '界'.repeat(342) })).toBe(false)
  })
  it('能力报告检测嵌套原因、重复标识和整体容量', () => {
    const report = fixtureValue('RuntimeReport')
    const agent = fixtureValue('RuntimeAgent')
    expect(Schema.is(RuntimeReport)({ ...report, agents: [{ ...agent, reason: 'x'.repeat(1025) }] })).toBe(false)
    expect(Schema.is(RuntimeReport)({ ...report, agents: [agent, agent] })).toBe(false)
    expect(Schema.is(RuntimeReport)({ ...report, agents: Array(33).fill(agent) })).toBe(false)
    expect(Schema.is(RuntimeReport)({ ...report, user: 'x'.repeat(65536) })).toBe(false)
  })
  it('完成报告必须携带命令 ID、结果和存储代次', () => {
    const base = fixtureValue('ThreadReport')
    const valid = {
      ...base,
      kind: 'command.completed',
      command_id: '12345678-1234-4234-8234-123456789abc',
      command_outcome: 'succeeded',
    }
    expect(Schema.is(ThreadReport)(valid)).toBe(true)
    for (const key of ['command_id', 'command_outcome', 'storage_generation', 'reason']) {
      const missing = { ...valid } as Record<string, unknown>
      delete missing[key]
      expect(Schema.is(ThreadReport)(missing)).toBe(false)
    }
    expect(Schema.is(CommandOutcome)('accepted')).toBe(false)
  })
  it('完成报告只匹配同一命令、Thread、认证节点和存储代次', () => {
    const base = fixtureValue('ThreadReport')
    const report = {
      ...base,
      kind: 'command.completed',
      command_id: '12345678-1234-4234-8234-123456789abc',
      command_outcome: 'succeeded',
    }
    const identity = {
      command_id: report.command_id,
      thread_id: String(base.thread_id),
      node_id: 'node-1',
      storage_generation: String(base.storage_generation),
    }
    expect(Schema.is(CommandCompleted)(report)).toBe(true)
    expect(isCommandCompletionFor(identity, report, 'node-1')).toBe(true)
    for (const key of ['command_id', 'thread_id', 'storage_generation'] as const) {
      expect(isCommandCompletionFor({ ...identity, [key]: 'other' }, report, 'node-1')).toBe(false)
    }
    expect(isCommandCompletionFor(identity, report, 'other-node')).toBe(false)
  })
  it('open 的成功接收回执必须携带存储代次', () => {
    const result = fixtureValue('ThreadCommandResult')
    delete result.storage_generation
    expect(Schema.is(ThreadOpenCommandResult)(result)).toBe(false)
    expect(Schema.is(ThreadOpenCommandResult)({ ...result, ok: false })).toBe(true)
    const command = Schema.decodeUnknownSync(dtoSchemas.ThreadCommand)({
      ...fixtureValue('ThreadCommand'),
      action: 'open',
    })
    expect(isCommandReceiptFor(command, result)).toBe(false)
    expect(isCommandReceiptFor(command, { ...result, storage_generation: 'generation-1' })).toBe(true)
    expect(
      isCommandReceiptFor(command, {
        ...result,
        storage_generation: 'generation-1',
        thread_id: '22345678-1234-4234-8234-123456789abc',
      }),
    ).toBe(false)
  })
  it('拒绝 reply 附件与元数据的错误结构和超限数据', () => {
    const base = fixtureValue('ThreadReport')
    expect(Schema.is(ThreadReport)({ ...base, attachments: {} })).toBe(false)
    expect(Schema.is(ThreadReport)({ ...base, metadata: [] })).toBe(false)
    expect(Schema.is(ThreadReport)({ ...base, metadata: { text: 'x'.repeat(4096) } })).toBe(false)
  })
  it('status 分别表示 Worker 接管与 Agent 就绪', () => {
    for (const item of worker.cases.filter(
      (item) => item.name === 'result.agent_starting' || item.name === 'result.agent_ready',
    )) {
      expect(Schema.encodeSync(WorkerStatusResult)(Schema.decodeUnknownSync(WorkerStatusResult)(item.value))).toEqual(
        item.value,
      )
    }
    expect(Schema.is(WorkerStatusResult)({ type: 'result', ok: true, worker_ready: false, agent_ready: true })).toBe(
      false,
    )
    expect(Schema.is(WorkerStatusResult)({ type: 'result', ok: true, worker_ready: true })).toBe(false)
  })
  it('Worker 认证和命令接收保留认证及去重约束', () => {
    expect(Schema.is(WorkerAuth)({ type: 'auth', ok: false, token: '0'.repeat(64) })).toBe(true)
    expect(Schema.is(WorkerAuth)({ type: 'auth', ok: false, token: 'bad' })).toBe(false)
    expect(Schema.is(WorkerRequest)({ type: 'thread_open', ok: false })).toBe(false)
  })
})
