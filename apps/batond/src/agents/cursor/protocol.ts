import { Schema } from 'effect'

/** Cursor-specific persisted state; the generic host protocol only knows the session id. */
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
