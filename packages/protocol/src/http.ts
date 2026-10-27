import { Schema, SchemaTransformation } from 'effect'
import { Cursor, NonNegativeInteger, StorageGeneration, Text, ThreadStatus, UUID, boundedText } from './common.ts'

export const BrowserSubscription = Schema.Struct({
  thread_id: Schema.Union([Schema.Literal(''), UUID]),
  cursor: Schema.optionalKey(Cursor),
})
export type BrowserSubscription = typeof BrowserSubscription.Type

export const BrowserThreadOutput = Schema.Struct({
  type: Schema.Literal('thread.output'),
  thread_id: Schema.optionalKey(UUID),
  operation_id: UUID,
  session_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  state: Schema.optionalKey(Text),
  text: Schema.optionalKey(boundedText(16 * 1024)),
  cursor: Schema.optionalKey(Cursor),
  gap: Schema.Boolean,
})
export type BrowserThreadOutput = typeof BrowserThreadOutput.Type

export const EmptyInput = Schema.Struct({}).check(Schema.makeFilter((value) => !Array.isArray(value)))
export const BrowserReady = Schema.Struct({ type: Schema.Literal('ready') })
export const BrowserThreadChanged = Schema.Struct({
  type: Schema.Literal('thread.changed'),
  thread_id: UUID,
  change: Schema.Literal('detail'),
})
export const BrowserProjectChanged = Schema.Struct({
  type: Schema.Literal('project.changed'),
  project_id: UUID,
  change: Schema.Literal('detail'),
})
export const NodesChanged = Schema.Struct({ type: Schema.Literal('nodes.changed'), node_id: UUID })
export const DevicesChanged = Schema.Struct({
  type: Schema.Literal('devices.changed'),
  node_id: UUID,
  report_version: NonNegativeInteger,
})
export type DevicesChanged = typeof DevicesChanged.Type
export const BrowserEvent = Schema.Union([
  BrowserReady,
  BrowserThreadChanged,
  BrowserProjectChanged,
  NodesChanged,
  DevicesChanged,
  BrowserThreadOutput,
])
export type BrowserEvent = typeof BrowserEvent.Type

// 查询参数保留 URL 上的字符串表示，转换为业务数值由 HTTP handler 完成。
const decimal = (minimum: number, maximum: number) =>
  Schema.String.check(
    Schema.isPattern(/^\d+$/),
    Schema.makeFilter(
      (value) => Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum,
    ),
  )
const pageLimit = Schema.optionalKey(decimal(1, 100))
const afterID = Schema.optionalKey(UUID)
const afterSequence = Schema.optionalKey(decimal(0, Number.MAX_SAFE_INTEGER))

export const ThreadListQuery = Schema.Struct({
  project_id: Schema.optionalKey(UUID),
  node_id: Schema.optionalKey(UUID),
  status: Schema.optionalKey(ThreadStatus),
  cursor: Schema.optionalKey(boundedText(4096)),
  limit: pageLimit,
})
export const ThreadTimelineQuery = Schema.Struct({ cursor: Schema.optionalKey(boundedText(4096)), limit: pageLimit })
export const ThreadOutputQuery = Schema.Struct({
  cursor: Schema.optionalKey(Cursor),
  action: Schema.optionalKey(Schema.Literals(['output', 'full_output'])),
  output_id: Schema.optionalKey(UUID),
  storage_generation: Schema.optionalKey(StorageGeneration),
})
export const ThreadTraceQuery = Schema.Struct({
  worker_turn_seq: decimal(1, Number.MAX_SAFE_INTEGER),
  cursor: Schema.optionalKey(boundedText(4096)),
})
export const FilesQuery = Schema.Struct({
  root_id: Schema.optionalKey(boundedText(64)),
  path: Schema.optionalKey(boundedText(4096)),
  cursor: Schema.optionalKey(boundedText(4096)),
  offset: Schema.optionalKey(decimal(0, Number.MAX_SAFE_INTEGER)),
  version: Schema.optionalKey(boundedText(128)),
})
export const ProjectListQuery = Schema.Struct({ after_id: afterID, limit: pageLimit })
export const ProjectMessagesQuery = Schema.Struct({
  client_message_id: Schema.optionalKey(boundedText(128)),
  after_id: afterSequence,
  limit: pageLimit,
})
export const ProjectEventsQuery = Schema.Struct({ after_seq: afterSequence, limit: pageLimit })
const memoryInteger = (minimum: number, maximum: number) =>
  decimal(minimum, maximum).pipe(Schema.decodeTo(NonNegativeInteger, SchemaTransformation.numberFromString))
export const MemoryRevisionsQuery = Schema.Struct({
  after_revision: Schema.optionalKey(memoryInteger(0, Number.MAX_SAFE_INTEGER)),
  limit: Schema.optionalKey(memoryInteger(1, 100)),
})
export const MemoryListQuery = Schema.Struct({
  after_id: afterID,
  limit: Schema.optionalKey(memoryInteger(1, 100)),
  include_inactive: Schema.optionalKey(Schema.Literals(['true', 'false'])),
})
export const MemorySourceQuery = Schema.Struct({
  offset: Schema.optionalKey(memoryInteger(0, Number.MAX_SAFE_INTEGER)),
  max_bytes: Schema.optionalKey(memoryInteger(4, 32768)),
})
export const InboxQuery = Schema.Struct({
  state: Schema.optionalKey(Schema.Literals(['open', 'done', 'all'])),
  cursor: Schema.optionalKey(boundedText(4096)),
  project_id: Schema.optionalKey(UUID),
  thread_id: Schema.optionalKey(UUID),
})
export const httpSchemas = {
  EmptyInput,
  BrowserReady,
  BrowserThreadChanged,
  BrowserProjectChanged,
  NodesChanged,
  DevicesChanged,
  ThreadListQuery,
  ThreadTimelineQuery,
  ThreadOutputQuery,
  ThreadTraceQuery,
  FilesQuery,
  ProjectListQuery,
  ProjectMessagesQuery,
  ProjectEventsQuery,
  MemoryRevisionsQuery,
  InboxQuery,
} as const
export type EmptyInput = typeof EmptyInput.Type
export type BrowserReady = typeof BrowserReady.Type
export type BrowserThreadChanged = typeof BrowserThreadChanged.Type
export type ThreadListQuery = typeof ThreadListQuery.Type
export type ThreadTimelineQuery = typeof ThreadTimelineQuery.Type
export type ThreadOutputQuery = typeof ThreadOutputQuery.Type
export type ThreadTraceQuery = typeof ThreadTraceQuery.Type
export type FilesQuery = typeof FilesQuery.Type
export type ProjectListQuery = typeof ProjectListQuery.Type
export type ProjectMessagesQuery = typeof ProjectMessagesQuery.Type
export type ProjectEventsQuery = typeof ProjectEventsQuery.Type
export type MemoryRevisionsQuery = typeof MemoryRevisionsQuery.Type
export type InboxQuery = typeof InboxQuery.Type
