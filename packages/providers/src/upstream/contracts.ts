import * as Schema from 'effect/Schema'

// Selected identifiers from t3code contracts/baseSchemas and providerInstance.
const TrimmedNonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
export const ThreadId = TrimmedNonEmptyString.pipe(Schema.brand('ThreadId'))
export type ThreadId = typeof ThreadId.Type
export const ProviderSessionId = TrimmedNonEmptyString.pipe(Schema.brand('ProviderSessionId'))
export type ProviderSessionId = typeof ProviderSessionId.Type
export const ProviderDriverKind = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
).pipe(Schema.brand('ProviderDriverKind'))
export type ProviderDriverKind = typeof ProviderDriverKind.Type
