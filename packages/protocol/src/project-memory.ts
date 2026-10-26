import { Schema } from 'effect'
import { UUID, Timestamp, Text, Integer, NonNegativeInteger, boundedText, summary } from './common.ts'

export const MemoryKind = Schema.Literals(['preference', 'fact', 'decision', 'lesson'])
export const MemoryStatus = Schema.Literals(['candidate', 'active', 'superseded', 'disputed', 'retired'])
export const MemoryBasis = Schema.Literals(['explicit', 'observed', 'inferred'])
export const MemoryAction = Schema.Literals(['add', 'support', 'correct', 'supersede', 'dispute', 'retire', 'restore'])
export const MemoryEvidence = Schema.Struct({
  source_id: UUID,
  start_byte: NonNegativeInteger,
  end_byte: NonNegativeInteger,
  source_hash: Text,
})
export type MemoryEvidence = typeof MemoryEvidence.Type
export const MemorySource = Schema.Struct({
  id: UUID,
  source_type: Text,
  role: Text,
  text: Text,
  source_hash: Text,
  source_seq: Schema.NullOr(Integer),
  input_id: Schema.NullOr(Integer),
  created_at: Timestamp,
  suppressed: Schema.Boolean,
})
export type MemorySource = typeof MemorySource.Type
export const MemoryContent = Schema.Struct({
  title: summary(1024).check(
    Schema.isMaxCodePoints(200),
    Schema.makeFilter((v) => v.trim().length > 0),
  ),
  content: boundedText(64 * 1024),
  kind: Schema.optionalKey(MemoryKind),
  topic: Schema.optionalKey(summary(1024)),
  conditions: Schema.optionalKey(boundedText(8192)),
  semantic_key: Schema.optionalKey(summary(1024)),
  core: Schema.optionalKey(Schema.Boolean),
  valid_from: Schema.optionalKey(Schema.NullOr(Timestamp)),
  valid_until: Schema.optionalKey(Schema.NullOr(Timestamp)),
  time_precision: Schema.optionalKey(Schema.Literals(['unknown', 'instant', 'day', 'range'])),
})
export const WriteMemoryInput = Schema.Struct({
  ...MemoryContent.fields,
  operation_id: UUID,
  expected_revision: NonNegativeInteger,
})
export type WriteMemoryInput = typeof WriteMemoryInput.Type
export const ChangeMemoryInput = Schema.Struct({
  operation_id: UUID,
  expected_revision: NonNegativeInteger,
  action: Schema.Literals(['retire', 'restore', 'supersede', 'dispute']),
  reason: Schema.optionalKey(boundedText(8192)),
  suppression_id: Schema.optionalKey(UUID),
  successor: Schema.optionalKey(MemoryContent),
})
export type ChangeMemoryInput = typeof ChangeMemoryInput.Type
export const ProjectMemory = Schema.Struct({
  id: UUID,
  ...MemoryContent.fields,
  kind: MemoryKind,
  topic: Text,
  conditions: Text,
  semantic_key: Text,
  core: Schema.Boolean,
  valid_from: Schema.NullOr(Timestamp),
  valid_until: Schema.NullOr(Timestamp),
  time_precision: Schema.Literals(['unknown', 'instant', 'day', 'range']),
  revision: Integer,
  author: Text,
  basis: MemoryBasis,
  status: MemoryStatus,
  source_seq: Schema.NullOr(Integer),
  updated_at: Timestamp,
  successor_id: Schema.NullOr(UUID),
  suppression_id: Schema.NullOr(UUID),
  action: MemoryAction,
  reason: Text,
  retracted: Schema.Boolean,
  effective: Schema.Boolean,
  evidence: Schema.Array(MemoryEvidence),
})
export type ProjectMemory = typeof ProjectMemory.Type
export const MemoriesResponse = Schema.Struct({
  entries: Schema.NullOr(Schema.Array(ProjectMemory)),
  next_after_id: Schema.optionalKey(Text),
})
export type MemoriesResponse = typeof MemoriesResponse.Type
export const MemoryRevision = ProjectMemory
export type MemoryRevision = ProjectMemory
export const MemoryRevisionsResponse = Schema.Struct({
  revisions: Schema.NullOr(Schema.Array(MemoryRevision)),
  next_after_revision: Schema.optionalKey(NonNegativeInteger),
})
export type MemoryRevisionsResponse = typeof MemoryRevisionsResponse.Type
export const MemoryConflictResponse = Schema.Struct({
  code: Text,
  message: Text,
  request_id: UUID,
  current_revision: Integer,
  current: Schema.NullOr(ProjectMemory),
})
export type MemoryConflictResponse = typeof MemoryConflictResponse.Type
export const MemorySourcePage = Schema.Struct({
  ...MemorySource.fields,
  offset: NonNegativeInteger,
  next_offset: NonNegativeInteger,
  has_more: Schema.Boolean,
})
