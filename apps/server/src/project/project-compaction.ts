import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { ProjectEvent, type ProjectRuntimeRequest } from '@baton/protocol'
import {
  appendProjectEvent,
  checkPayloadSize,
  projectDecode,
  projectError,
  readEvent,
  type ProjectBinding,
} from './project-store.ts'
import { previousClientEvent, savedToolCalls } from './project-events.ts'
import { canonical } from '../threads-core.ts'

const Prompt = Schema.Struct({ version: Schema.String, title: Schema.String, goal: Schema.String })
const Compaction = Schema.Struct({
  through_seq: Schema.Int,
  summary: Schema.String,
  cleared_tool_result_seqs: Schema.Array(Schema.Int),
  memory_index: Schema.String,
  prompt: Prompt,
  tokens_before: Schema.Number,
  tokens_after: Schema.Number,
  provider: Schema.String,
  model: Schema.String,
  usage: Schema.optionalKey(Schema.Json),
})
type Compaction = typeof Compaction.Type
const frame = (p: Compaction) =>
  p.through_seq === 0 && p.summary === ''
    ? ''
    : `[程序说明] 以下摘要替换了第 1～${p.through_seq} 条对话。原文可用 history.read 按序号读取，history.search 按关键字搜索。\n<项目记忆索引>${p.memory_index}</项目记忆索引>\n<对话摘要>${p.summary}</对话摘要>`
const clearedText = (seq: number) =>
  `[工具结果已清除，原文为第 ${seq} 条。需要时用 history.read 读取，或重新调用工具获取最新状态]`
const Content = Schema.Union([
  Schema.String,
  Schema.Array(
    Schema.StructWithRest(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optionalKey(Schema.String),
        thinking: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
      }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  ),
])
const MessagePayload = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.StructWithRest(Schema.Struct({ content: Content }), [Schema.Record(Schema.String, Schema.Json)]),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
const contentLength = (content: typeof Content.Type) =>
  typeof content === 'string'
    ? content.length
    : content.reduce(
        (n, block) =>
          n +
          (block.type === 'text'
            ? (block.text ?? '').length
            : block.type === 'thinking'
              ? (block.thinking ?? '').length
              : block.type === 'toolCall'
                ? (block.name ?? '').length + JSON.stringify(block.arguments).length
                : block.type === 'image'
                  ? 4800
                  : 0),
        0,
      )
export const projectMemoryIndex = Effect.fn('projectMemoryIndex')(function* (projectId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    title: string
  }>`SELECT title FROM project_memory_entries WHERE project_id=${projectId} ORDER BY id LIMIT 129`
  let index = ''
  for (const [i, row] of rows.entries()) {
    const line = '- ' + row.title + '\n'
    if (i === 128 || Buffer.byteLength(index + line) > 2044) return index + '…'
    index += line
  }
  return index
})
export const commitCompaction = Effect.fn('commitProjectCompaction')(function* (
  b: ProjectBinding,
  request: ProjectRuntimeRequest,
) {
  const p = yield* projectDecode(Compaction, request.payload)
  yield* checkPayloadSize(p)
  if (
    p.through_seq < 0 ||
    !p.prompt.title ||
    p.prompt.version !== b.promptVersion ||
    p.provider !== b.provider ||
    p.model !== b.model ||
    p.tokens_before <= 0 ||
    p.tokens_after < 0 ||
    p.tokens_after >= p.tokens_before ||
    Buffer.byteLength(p.memory_index) > 2048 ||
    [p.summary, p.memory_index, p.prompt.title, p.prompt.goal].some((v) => v.includes('\0'))
  )
    return yield* Effect.fail(projectError('invalid', 422))
  const old = yield* previousClientEvent(b, request.client_event_id ?? '', 'compaction', p)
  if (old) return old
  if ((request.last_seq ?? 0) !== b.nextSeq - 1) return yield* Effect.fail(projectError())
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    compaction_seq: string | null
  }>`SELECT compaction_seq FROM conversations WHERE id=${b.conversationId}`
  const previous: Compaction = row?.compaction_seq
    ? yield* projectDecode(Compaction, (yield* readEvent(b.conversationId, Number(row.compaction_seq))).payload)
    : {
        through_seq: 0,
        summary: '',
        cleared_tool_result_seqs: [],
        memory_index: '',
        prompt: { version: '', title: '', goal: '' },
        tokens_before: 0,
        tokens_after: 0,
        provider: '',
        model: '',
      }
  if (
    p.through_seq < previous.through_seq ||
    (p.through_seq === previous.through_seq && p.summary !== previous.summary) ||
    (p.through_seq > previous.through_seq && !p.summary.trim())
  )
    return yield* Effect.fail(projectError('invalid', 422))
  const rows = yield* sql<{
    value: unknown
  }>`SELECT to_jsonb(e)-'employee_id' AS value FROM conversation_events e WHERE conversation_id=${b.conversationId} AND seq>${previous.through_seq} ORDER BY seq`
  const events = yield* Effect.forEach(rows, (r) => projectDecode(ProjectEvent, r.value))
  const bySeq = new Map(events.map((e) => [e.seq, e])),
    pending = new Set<string>(),
    oldCleared = new Set(previous.cleared_tool_result_seqs)
  let balanced = p.through_seq === previous.through_seq,
    last = 0,
    lastAssistant = 0,
    prefixChars = frame(previous).length
  for (const event of events) {
    if (event.kind === 'compaction') continue
    last = event.seq
    if (event.kind === 'assistant') lastAssistant = event.seq
    if (event.seq > p.through_seq) continue
    const body = yield* projectDecode(MessagePayload, event.payload)
    if (event.kind === 'assistant') for (const call of yield* savedToolCalls(event.payload)) pending.add(call.id)
    if (event.kind === 'tool_result') {
      const id = body.message.toolCallId
      if (typeof id !== 'string' || !pending.delete(id)) return yield* Effect.fail(projectError('invalid', 422))
    }
    prefixChars += oldCleared.has(event.seq) ? clearedText(event.seq).length : contentLength(body.message.content)
    if (event.seq === p.through_seq) balanced = pending.size === 0 && event.kind !== 'input'
  }
  if (!balanced || p.through_seq >= last) return yield* Effect.fail(projectError('invalid', 422))
  const cleared = new Set<number>()
  let prev = 0
  for (const seq of p.cleared_tool_result_seqs) {
    const event = bySeq.get(seq)
    if (!event || seq <= prev || seq <= p.through_seq || event.kind !== 'tool_result' || seq >= lastAssistant)
      return yield* Effect.fail(projectError('invalid', 422))
    prev = seq
    cleared.add(seq)
    if (!oldCleared.has(seq)) {
      const body = yield* projectDecode(MessagePayload, event.payload)
      if (
        events.filter((e) => e.kind === 'input' && e.seq > seq).length < 3 ||
        contentLength(body.message.content) <= clearedText(seq).length
      )
        return yield* Effect.fail(projectError('invalid', 422))
    }
  }
  if ([...oldCleared].some((seq) => seq > p.through_seq && !cleared.has(seq)))
    return yield* Effect.fail(projectError('invalid', 422))
  const [project] = yield* sql<{ title: string; goal: string }>`SELECT title,goal FROM projects WHERE id=${b.projectId}`
  if (p.through_seq === previous.through_seq) {
    if (cleared.size <= oldCleared.size || p.memory_index !== previous.memory_index)
      return yield* Effect.fail(projectError('invalid', 422))
    let prompt = previous.prompt
    if (!prompt.version) {
      for (const e of events) {
        if (e.kind !== 'assistant') continue
        const payload = yield* projectDecode(Schema.Record(Schema.String, Schema.Json), e.payload)
        if (payload.prompt) {
          prompt = yield* projectDecode(Prompt, payload.prompt)
          break
        }
      }
    }
    if (!prompt.version) prompt = { version: b.promptVersion, title: project!.title, goal: project!.goal }
    if (canonical(p.prompt) !== canonical(prompt)) return yield* Effect.fail(projectError())
  } else {
    if (frame(p).length >= prefixChars) return yield* Effect.fail(projectError('invalid', 422))
    if (p.prompt.title !== project?.title || p.prompt.goal !== project.goal) return yield* Effect.fail(projectError())
  }
  const event = yield* appendProjectEvent(b, 'compaction', p, request.client_event_id!)
  yield* sql`UPDATE conversations SET compaction_seq=${event.seq} WHERE id=${b.conversationId}`
  return event
})
