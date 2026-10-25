import { Schema } from 'effect'

const piSelectionError = Schema.Struct({
  _tag: Schema.Literal('PiRpcError'),
  operation: Schema.Literal('set_model'),
})
const piTurnSelectionError = Schema.Struct({
  _tag: Schema.Literal('ProviderAdapterTurnStartError'),
  driver: Schema.Literal('pi'),
  cause: piSelectionError,
})
const cursorSelectionError = Schema.Struct({ _tag: Schema.Literal('CursorModelUnavailableError') })

/** These upstream errors occur before prompt submission; transport errors remain uncertain. */
export const modelRejectedBeforeInput = (agentType: string, cause: unknown): boolean =>
  (agentType === 'pi' && (Schema.is(piSelectionError)(cause) || Schema.is(piTurnSelectionError)(cause))) ||
  (agentType === 'cursor' && Schema.is(cursorSelectionError)(cause))
