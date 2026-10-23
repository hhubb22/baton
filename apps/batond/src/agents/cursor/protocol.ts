import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { WorkerOpenConfig } from '@baton/protocol'

export const NativeMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String,
})
export type NativeMessage = typeof NativeMessage.Type

export const NativeMapping = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  nativeSessionId: Schema.String,
  cwd: Schema.String,
  statePath: Schema.String,
  storePath: Schema.String,
})
export type NativeMapping = typeof NativeMapping.Type

export const Message = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  epoch: Schema.Number,
  operationId: Schema.String,
  mode: Schema.Literals(['queue', 'steer']),
  model: Schema.optionalKey(Schema.String),
  targetTurn: Schema.optionalKey(Schema.Number),
})
export const Preparation = Schema.Struct({
  nativeSessionId: Schema.String,
  preparationId: Schema.String,
  userCount: Schema.Number,
  prefixDigest: Schema.String,
  evidence: Schema.optionalKey(Schema.Json),
})
export const Acceptance = Schema.Struct({ nativeSessionId: Schema.String, executionId: Schema.String })
const identity = { nativeSessionId: Schema.String, messageId: Schema.String, executionId: Schema.String }
export const ExecutionEvent = Schema.Union([
  Schema.Struct({ ...identity, type: Schema.Literal('reply'), id: Schema.String, text: Schema.String }),
  Schema.Struct({ ...identity, type: Schema.Literal('delta'), id: Schema.String, text: Schema.String }),
  Schema.Struct({ ...identity, type: Schema.Literal('end'), outcome: Schema.Literals(['completed', 'cancelled']) }),
  Schema.Struct({ type: Schema.Literal('uncertain'), reason: Schema.String }),
])
export type ExecutionEvent = typeof ExecutionEvent.Type
export const HostEvent = Schema.Struct({ generation: Schema.String, sequence: Schema.Number, event: ExecutionEvent })
export type HostEvent = typeof HostEvent.Type

export class CursorHostError extends Schema.TaggedError<CursorHostError>()('CursorHostError', {
  message: Schema.String,
}) {}

export const ProbeResult = Schema.Struct({
  authenticated: Schema.Literals(['valid', 'missing', 'unknown']),
  models: Schema.Array(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  sdkVersion: Schema.String,
  platform: Schema.String,
  integrity: Schema.Boolean,
  sandboxHelper: Schema.Boolean,
})
export type ProbeResult = typeof ProbeResult.Type

export const CursorHostRpc = RpcGroup.make(
  Rpc.make('probe', { success: ProbeResult, error: CursorHostError }),
  Rpc.make('open', {
    payload: { config: WorkerOpenConfig, generation: Schema.String, mapping: Schema.optionalKey(NativeMapping) },
    success: NativeMapping,
    error: CursorHostError,
  }),
  Rpc.make('send', {
    payload: { message: Message, preparation: Preparation },
    success: Acceptance,
    error: CursorHostError,
  }),
  Rpc.make('history', { payload: NativeMapping, success: Schema.Array(NativeMessage), error: CursorHostError }),
  Rpc.make('events', { success: HostEvent, stream: true, error: CursorHostError }),
  Rpc.make('abort', { error: CursorHostError }),
  Rpc.make('close', { error: CursorHostError }),
)
