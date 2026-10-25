import { Schema } from 'effect'
import { NonNegativeInteger, StorageGeneration, Timestamp, UUID } from './common.ts'

export const FullOutputReference = Schema.Struct({
  id: UUID,
  storage_generation: StorageGeneration,
  total_bytes: NonNegativeInteger,
  expires_at: Timestamp,
})
export type FullOutputReference = typeof FullOutputReference.Type

export const FullOutputPage = Schema.Struct({
  output_id: UUID,
  storage_generation: StorageGeneration,
  offset: NonNegativeInteger,
  next_offset: NonNegativeInteger,
  total_bytes: NonNegativeInteger,
  expires_at: Timestamp,
  encoding: Schema.Literal('base64'),
  data: Schema.String.check(Schema.isMaxLength(16 * 1024)),
  done: Schema.Boolean,
})
export type FullOutputPage = typeof FullOutputPage.Type
