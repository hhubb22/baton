import { Schema } from 'effect'

export const TraceContext = Schema.Struct({
  traceparent: Schema.String.check(Schema.isPattern(/^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/)),
  tracestate: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(/^[\x20-\x7e]*$/))),
})
export type TraceContext = typeof TraceContext.Type
