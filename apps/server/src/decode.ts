import { Effect, Schema } from 'effect'
import { AppError } from './errors.ts'

export const strictDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(() => new AppError(422, 'invalid')),
  )
