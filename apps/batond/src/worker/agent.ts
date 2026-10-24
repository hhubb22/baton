import type { WorkerOpenConfig } from '@baton/protocol'
import type { Effect, Schema, Stream } from 'effect'
import type { AgentOutput } from './output.ts'
export type { AgentOutput } from './output.ts'

export type JsonValue = typeof Schema.Json.Type

export class AgentError extends Error {
  readonly _tag = 'AgentError'
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface AgentMessage {
  readonly id: string
  readonly text: string
  readonly epoch: number
  readonly operationId: string
  readonly mode: 'queue' | 'steer'
  readonly model?: string
  readonly targetTurn?: number
}

/** Durable evidence, at most 4 KiB encoded. restoreInput only restores local state. */
export interface InputPreparation {
  readonly nativeSessionId: string
  readonly preparationId: string
  readonly userCount: number
  readonly prefixDigest: string
  readonly evidence?: JsonValue
}

export interface InputAcceptance {
  readonly nativeSessionId: string
  readonly executionId: string
}

export interface AgentEventIdentity {
  readonly nativeSessionId: string
  readonly messageId: string
  readonly executionId: string
}

export type AgentEvent =
  | (AgentEventIdentity & {
      readonly type: 'reply'
      readonly id: string
      readonly text: string
      readonly attachments?: readonly JsonValue[]
      readonly metadata?: NonNullable<import('@baton/protocol').ThreadReport['metadata']>
      readonly original_bytes?: number
      readonly truncated?: boolean
    })
  | (AgentEventIdentity & { readonly type: 'end'; readonly outcome: 'completed' | 'cancelled' })
  | { readonly type: 'uncertain'; readonly reason: string }
  | { readonly type: 'exited'; readonly reason: string; readonly processTreeStopped: boolean }

/**
 * Each instance belongs to one execution lifetime. abort/close/reap may be terminal;
 * the Worker obtains a fresh instance for resume and recovery after reaping.
 * Events contain only fresh execution output.
 * open/resume persist the native mapping before returning. Cancellation must prevent late
 * resource creation; reap confirms the entire process tree, including pending startup.
 * send returns native acceptance evidence, never just a transport write or SDK handle.
 */
export interface ThreadAgent {
  readonly open: (config: WorkerOpenConfig) => Effect.Effect<{ readonly nativeSessionId: string }, AgentError>
  readonly resume: (
    nativeSessionId: string,
    config: WorkerOpenConfig,
  ) => Effect.Effect<{ readonly nativeSessionId: string }, AgentError>
  readonly prepareInput: (message: AgentMessage) => Effect.Effect<InputPreparation, AgentError>
  readonly restoreInput: (message: AgentMessage, preparation: InputPreparation) => Effect.Effect<void, AgentError>
  readonly send: (message: AgentMessage, preparation: InputPreparation) => Effect.Effect<InputAcceptance, AgentError>
  /** Read-only evidence lookup; must also work before resume and after a broken execution channel. */
  readonly sent: (
    message: AgentMessage,
    preparation: InputPreparation,
  ) => Effect.Effect<InputAcceptance | undefined, AgentError>
  readonly events: Stream.Stream<AgentEvent, AgentError>
  /** Best-effort fresh text; bounded separately from durable reply and lifecycle events. */
  readonly output?: Stream.Stream<AgentOutput, AgentError>
  /** Registers cancellation immediately; its response alone does not confirm termination. */
  readonly abort: () => Effect.Effect<void, AgentError>
  readonly close: () => Effect.Effect<void, AgentError>
  readonly reap: () => Effect.Effect<{ readonly processTreeStopped: boolean }, AgentError>
  readonly readHistory: (cursor?: string) => Effect.Effect<JsonValue, AgentError>
}

/** Each call returns a fresh instance; construction must not create processes or perform I/O. */
export type AgentFactory = (config: WorkerOpenConfig) => ThreadAgent
