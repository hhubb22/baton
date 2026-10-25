import { Context, Effect, Schema, Stream } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { ThreadAnswerInput, ThreadQuestion, WorkerOpenConfig } from '@baton/protocol'

/** One input submitted to the native Agent. */
export const AgentMessage = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  epoch: Schema.Number,
  operationId: Schema.String,
  mode: Schema.Literals(['queue', 'steer']),
  model: Schema.optionalKey(Schema.String),
  targetTurn: Schema.optionalKey(Schema.Number),
})
export type AgentMessage = typeof AgentMessage.Type

/** Durable evidence produced locally by the Worker; it never triggers native history reads. */
export const Preparation = Schema.Struct({
  nativeSessionId: Schema.String,
  preparationId: Schema.String,
  /** Native user messages the Worker already saw accepted before this input. */
  confirmedSends: Schema.Number,
})
export type Preparation = typeof Preparation.Type

export const Acceptance = Schema.Struct({ nativeSessionId: Schema.String, executionId: Schema.String })
export type Acceptance = typeof Acceptance.Type

export const SessionIdentity = Schema.Struct({ nativeSessionId: Schema.String })
export type SessionIdentity = typeof SessionIdentity.Type

const identity = { nativeSessionId: Schema.String, messageId: Schema.String, executionId: Schema.String }
export const ExecutionEvent = Schema.Union([
  Schema.Struct({ ...identity, type: Schema.Literal('question'), question: ThreadQuestion }),
  Schema.Struct({ ...identity, type: Schema.Literal('question.resolved'), requestId: Schema.String }),
  Schema.Struct({ ...identity, type: Schema.Literal('reply'), id: Schema.String, text: Schema.String }),
  Schema.Struct({
    ...identity,
    type: Schema.Literal('delta'),
    id: Schema.String,
    text: Schema.String,
    gap: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ ...identity, type: Schema.Literal('end'), outcome: Schema.Literals(['completed', 'cancelled']) }),
  Schema.Struct({
    ...identity,
    type: Schema.Literal('end'),
    outcome: Schema.Literal('failed'),
    reason: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal('uncertain'), reason: Schema.String }),
])
export type ExecutionEvent = typeof ExecutionEvent.Type

export const HostEvent = Schema.Struct({ generation: Schema.String, sequence: Schema.Number, event: ExecutionEvent })
export type HostEvent = typeof HostEvent.Type

export class AgentHostError extends Schema.TaggedError<AgentHostError>()('AgentHostError', {
  message: Schema.String,
  /** Explicit native model rejection before input submission. */
  modelRejected: Schema.optionalKey(Schema.Boolean),
}) {}

export const ProbeDetail = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
export type ProbeDetail = typeof ProbeDetail.Type

/**
 * Fixed-shape probe report. Agent-specific facts live in `details`, so the RPC
 * stays the same for every Agent while the registry keeps validating them.
 */
export const ProbeResult = Schema.Struct({
  authenticated: Schema.Literals(['valid', 'missing', 'unknown']),
  models: Schema.Array(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  details: Schema.Record(Schema.String, ProbeDetail),
})
export type ProbeResult = typeof ProbeResult.Type

/** What the host process runs for one Agent type. */
export interface AgentHostDriverShape {
  readonly probe: Effect.Effect<ProbeResult, AgentHostError>
  readonly open: (input: {
    readonly config: WorkerOpenConfig
    readonly generation: string
  }) => Effect.Effect<SessionIdentity, AgentHostError>
  readonly resume: (input: {
    readonly config: WorkerOpenConfig
    readonly generation: string
    readonly nativeSessionId: string
  }) => Effect.Effect<SessionIdentity, AgentHostError>
  readonly send: (input: {
    message: AgentMessage
    preparation: Preparation
  }) => Effect.Effect<Acceptance, AgentHostError>
  readonly sent: (input: {
    config: WorkerOpenConfig
    message: AgentMessage
    preparation: Preparation
  }) => Effect.Effect<Acceptance | undefined, AgentHostError>
  readonly answer?: (input: ThreadAnswerInput) => Effect.Effect<void, AgentHostError>
  /** Reply, end and uncertain events; deltas are merged in by the same stream. */
  readonly events: Stream.Stream<ExecutionEvent, AgentHostError>
  readonly abort: Effect.Effect<void, AgentHostError>
  readonly close: Effect.Effect<void, AgentHostError>
}

export class AgentHostDriver extends Context.Service<AgentHostDriver, AgentHostDriverShape>()(
  'baton/agent-host/AgentHostDriver',
) {}

/** Host process group controls, shared by Agent drivers that stop their own steps. */
export class AgentHostProcessGroup extends Context.Service<
  AgentHostProcessGroup,
  {
    readonly terminateChildren: Effect.Effect<void, AgentHostError>
    readonly waitQuiescent: (timeoutMs: number) => Effect.Effect<void, AgentHostError>
  }
>()('baton/agent-host/ProcessGroup') {}

export const AgentHostRpc = RpcGroup.make(
  Rpc.make('probe', { success: ProbeResult, error: AgentHostError }),
  Rpc.make('open', {
    payload: { config: WorkerOpenConfig, generation: Schema.String },
    success: SessionIdentity,
    error: AgentHostError,
  }),
  Rpc.make('resume', {
    payload: { config: WorkerOpenConfig, generation: Schema.String, nativeSessionId: Schema.String },
    success: SessionIdentity,
    error: AgentHostError,
  }),
  Rpc.make('send', {
    payload: { message: AgentMessage, preparation: Preparation },
    success: Acceptance,
    error: AgentHostError,
  }),
  Rpc.make('sent', {
    payload: { config: WorkerOpenConfig, message: AgentMessage, preparation: Preparation },
    success: Schema.NullOr(Acceptance),
    error: AgentHostError,
  }),
  Rpc.make('answer', { payload: { answer: ThreadAnswerInput }, error: AgentHostError }),
  Rpc.make('events', { success: HostEvent, stream: true, error: AgentHostError }),
  Rpc.make('abort', { error: AgentHostError }),
  Rpc.make('close', { error: AgentHostError }),
)
