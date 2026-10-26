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
export const MemoryEmbeddingConfigInput = Schema.Struct({
  base_url: summary(2048).check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      } catch {
        return false
      }
    }),
  ),
  model: summary(1024).check(Schema.makeFilter((v) => v.trim().length > 0)),
  credential_profile: Schema.optionalKey(summary(64).check(Schema.isPattern(/^[a-z0-9-]{1,64}$/))),
})
export type MemoryEmbeddingConfigInput = typeof MemoryEmbeddingConfigInput.Type
export const MemoryEmbeddingConfig = Schema.Struct({ ...MemoryEmbeddingConfigInput.fields, config_id: UUID })
export type MemoryEmbeddingConfig = typeof MemoryEmbeddingConfig.Type
export const EmbeddingVector = Schema.Array(Schema.Finite).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.makeFilter((v) => v.some((n) => Math.fround(n) !== 0) && v.every((n) => Number.isFinite(Math.fround(n)))),
)
export const MemoryQueryVector = Schema.Struct({ config_id: UUID, query_hash: Text, vector: EmbeddingVector })
export type MemoryQueryVector = typeof MemoryQueryVector.Type
export const MemoryEmbeddingQuery = Schema.Struct({
  query: Text,
  query_hash: Text,
  input_seq: NonNegativeInteger,
  last_seq: NonNegativeInteger,
  query_truncated: Schema.Boolean,
  memory_embedding: Schema.NullOr(MemoryEmbeddingConfig),
})
export type MemoryEmbeddingQuery = typeof MemoryEmbeddingQuery.Type
export const MemoryEmbeddingCommit = Schema.Struct({
  item_id: UUID,
  revision: Integer,
  config_id: UUID,
  embedding_text_hash: Text,
  vector: EmbeddingVector,
})
export type MemoryEmbeddingCommit = typeof MemoryEmbeddingCommit.Type

export const MEMORY_CONTEXT_DEFAULTS = { core_tokens: 1500, related_tokens: 3500, max_bytes: 40 * 1024 } as const
export const MemoryRecallInput = Schema.Struct({
  query: boundedText(64 * 1024),
  mode: Schema.optionalKey(Schema.Literals(['current', 'history'])),
  as_of: Schema.optionalKey(Timestamp),
  include_inactive: Schema.optionalKey(Schema.Boolean),
  max_results: Schema.optionalKey(NonNegativeInteger.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  max_bytes: Schema.optionalKey(NonNegativeInteger.check(Schema.isBetween({ minimum: 1024, maximum: 32768 }))),
}).check(Schema.makeFilter((v) => v.mode === 'history' || (v.as_of === undefined && v.include_inactive === undefined)))
export type MemoryRecallInput = typeof MemoryRecallInput.Type
export const MemoryReference = Schema.Union([
  Schema.Struct({
    item_id: UUID,
    revision: Integer,
    mode: Schema.Literals(['current', 'history']),
    as_of: Schema.optionalKey(Timestamp),
  }),
  Schema.Struct({
    ...MemoryEvidence.fields,
    mode: Schema.Literals(['current', 'history']),
    as_of: Schema.optionalKey(Timestamp),
  }),
])
export const MemoryRecallHit = Schema.Struct({
  document_id: Text,
  item: Schema.optionalKey(
    Schema.Struct({
      id: UUID,
      revision: Integer,
      status: MemoryStatus,
      effective: Schema.Boolean,
      retracted: Schema.Boolean,
      evidence: Schema.Array(MemoryEvidence),
      evidence_count: NonNegativeInteger,
      read_tool: Schema.Literal('memory.read'),
    }),
  ),
  snippet_truncated: Schema.Boolean,
  source: Schema.optionalKey(
    Schema.Struct({
      source_id: UUID,
      source_hash: Text,
      start_byte: NonNegativeInteger,
      end_byte: NonNegativeInteger,
      source_seq: Schema.NullOr(Integer),
      role: Text,
      suppressed: Schema.Boolean,
      related_items: Schema.Array(Schema.Struct({ item_id: UUID, status: MemoryStatus, effective: Schema.Boolean })),
    }),
  ),
  snippet: Text,
  score: Schema.Number,
})
export type MemoryRecallHit = typeof MemoryRecallHit.Type
export const MemoryRecallResult = Schema.Struct({
  entries: Schema.Array(MemoryRecallHit),
  memory_refs: Schema.Array(MemoryReference),
  derived: Schema.Literal(true),
  query_truncated: Schema.Boolean,
  candidate_truncated: Schema.Boolean,
  result_truncated: Schema.Boolean,
  no_match: Schema.Boolean,
  degraded: Schema.Array(Text),
  algorithm: Text,
})
export const PrepareMemoryContext = Schema.Struct({
  context_id: UUID,
  input_seq: NonNegativeInteger,
  core_tokens: NonNegativeInteger.check(Schema.isLessThanOrEqualTo(1500)),
  related_tokens: NonNegativeInteger.check(Schema.isLessThanOrEqualTo(3500)),
  max_bytes: NonNegativeInteger.check(Schema.isBetween({ minimum: 1024, maximum: 40960 })),
  query_vector: Schema.optionalKey(MemoryQueryVector),
  embedding_diagnostic: Schema.optionalKey(
    Schema.Literals(['credential_missing', 'embedding_request_failed', 'embedding_timeout', 'embedding_unavailable']),
  ),
})
export type PrepareMemoryContext = typeof PrepareMemoryContext.Type
export const MemoryContext = Schema.Struct({
  context_id: UUID,
  last_seq: NonNegativeInteger,
  input_seq: NonNegativeInteger,
  budget: Schema.Struct({
    core_tokens: NonNegativeInteger,
    related_tokens: NonNegativeInteger,
    max_bytes: NonNegativeInteger,
  }),
  knowledge_epoch: NonNegativeInteger,
  expires_at: Schema.NullOr(Timestamp),
  content: Text,
  memory_refs: Schema.Array(MemoryReference),
  degraded: Schema.Array(Text),
  core_complete: Schema.Boolean,
  query: Text,
  algorithm: Text,
})
export type MemoryContext = typeof MemoryContext.Type

export const MemorySourcePage = Schema.Struct({
  ...MemorySource.fields,
  offset: NonNegativeInteger,
  next_offset: NonNegativeInteger,
  has_more: Schema.Boolean,
})
