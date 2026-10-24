import { Schema } from 'effect'

/** Native session attribution persisted by the Agent host before `open`/`resume` returns. */
export const NativeMapping = Schema.Struct({
  version: Schema.Literal(2),
  threadId: Schema.String,
  nativeSessionId: Schema.String,
  cwd: Schema.String,
  statePath: Schema.String,
  /** Upstream `OrchestrationV2ProviderThread`, kept opaque here and decoded by the driver. */
  providerThread: Schema.Json,
})
export type NativeMapping = typeof NativeMapping.Type

/** Snapshot message projected by the upstream adapter's `readThreadSnapshot`. */
export interface SnapshotMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
}
