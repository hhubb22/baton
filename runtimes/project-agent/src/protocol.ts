import type { Message } from '@earendil-works/pi-ai'
import { Schema } from 'effect'
export interface Event {
  seq: number
  kind: 'input' | 'assistant' | 'tool_result' | 'compaction'
  payload: any
}
export interface Bootstrap {
  project: {
    title: string
    goal: string
    agent: { provider: string; model: string }
    conversation: { id: string }
  }
  prompt_version: string
  memory_index?: string
  compaction?: Event | null
  compaction_seq?: number
  goal_utf8_base64?: string
  local_wait_protocol?: number
  after_seq: number
  last_seq: number
}
export interface Request<O extends Operation = Operation> {
  operation: O
  last_seq?: number
  after_seq?: number
  max_bytes?: number
  client_event_id?: string
  payload?: unknown
  reason?: string
  tool_call_id?: string
  tool_name?: string
  arguments?: unknown
}
const sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const eventSchema = Schema.Struct({
  seq: sequence,
  kind: Schema.Literals(['input', 'assistant', 'tool_result', 'compaction']),
  payload: Schema.Record(Schema.String, Schema.Unknown),
})
const eventOfKind = <K extends Event['kind']>(kind: K) =>
  Schema.Struct({
    ...eventSchema.fields,
    kind: Schema.Literal(kind),
  })
const bootstrapSchema = Schema.Struct({
  project: Schema.Struct({
    title: Schema.String,
    goal: Schema.String,
    agent: Schema.Struct({ provider: Schema.String, model: Schema.String }),
    conversation: Schema.Struct({ id: Schema.String }),
  }),
  prompt_version: Schema.String,
  memory_index: Schema.optionalKey(Schema.String),
  compaction: Schema.optionalKey(Schema.NullOr(eventOfKind('compaction'))),
  compaction_seq: Schema.optionalKey(sequence),
  goal_utf8_base64: Schema.optionalKey(Schema.String),
  local_wait_protocol: Schema.optionalKey(Schema.Int),
  after_seq: sequence,
  last_seq: sequence,
})
const pendingSchema = Schema.Union([
  Schema.Struct({
    pending: Schema.Literal(true),
    thread_id: Schema.NonEmptyString,
    wait_protocol: Schema.Literal(1),
    version: sequence,
    wait_remaining_ms: sequence,
  }),
  Schema.Struct({
    pending: Schema.Literal(true),
    thread_id: Schema.NonEmptyString,
    wait_protocol: Schema.optionalKey(Schema.Number.check(Schema.makeFilter((value) => value !== 1))),
    version: Schema.optionalKey(sequence),
    wait_remaining_ms: Schema.optionalKey(sequence),
  }),
])
const toolResultSchema = Schema.Union([
  pendingSchema,
  Schema.Struct({ ...eventOfKind('tool_result').fields, pending: Schema.optionalKey(Schema.Literal(false)) }),
])
const recordSchema = Schema.Record(Schema.String, Schema.Unknown)
const resultSchemas = {
  bootstrap: bootstrapSchema,
  read_events: Schema.Struct({
    events: Schema.NullOr(Schema.mutable(Schema.Array(eventSchema))),
    last_seq: sequence,
    next_after_seq: sequence,
    has_more: Schema.Boolean,
  }),
  claim_inputs: Schema.Struct({
    event: Schema.optionalKey(Schema.NullOr(eventOfKind('input'))),
    payload_bytes: sequence,
    input_count: sequence,
  }),
  append_event: eventOfKind('assistant'),
  commit_compaction: eventOfKind('compaction'),
  call_tool: toolResultSchema,
  wait_tool: toolResultSchema,
  poll_wake: Schema.Union([
    Schema.Struct({ wake: Schema.Boolean }),
    Schema.Struct({ reason: Schema.Literals(['thread_changed', 'timeout']), version: Schema.optionalKey(sequence) }),
  ]),
  preview: recordSchema,
  finish: recordSchema,
  report_failure: recordSchema,
}
export type Operation = keyof typeof resultSchemas
export type Results = { [O in Operation]: (typeof resultSchemas)[O]['Type'] }
export interface RPC {
  call<O extends Operation>(request: Request<O>): Promise<Results[O]>
}
const envelopeSchema = Schema.Struct({
  type: Schema.Literal('project_runtime.result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
})
export class RuntimeError extends Error {
  constructor(public code: string) {
    super(code)
  }
}
function validResult<O extends Operation>(operation: O, value: unknown): value is Results[O] {
  return Schema.is(resultSchemas[operation])(value)
}

export function checkedRPC(call: (request: Request) => Promise<unknown>): RPC {
  return {
    async call<O extends Operation>(request: Request<O>): Promise<Results[O]> {
      const result = await call(request)
      if (!Schema.is(envelopeSchema)(result)) throw new RuntimeError('invalid_response')
      if (!result.ok) throw new RuntimeError(result.code ?? 'invalid_response')
      if (!validResult(request.operation, result.data)) throw new RuntimeError('invalid_response')
      // 只检查结构，原始对象保留 pi-ai 签名及所有扩展字段。
      return result.data
    },
  }
}

// jsonb 会调整对象键顺序；递归排序保留消息的全部字段和数组顺序。
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    ) as T
  return value
}
export function eventMessage(event: Event): Message {
  if (event.payload.format !== 'pi-ai/1' || !event.payload.message) throw new RuntimeError('unsupported_event')
  return canonical(event.payload.message)
}
