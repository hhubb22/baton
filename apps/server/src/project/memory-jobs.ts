import { createHash, randomUUID } from 'node:crypto'
import { Effect, Result, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError, type NodeSource } from '../errors.ts'
import { canonical } from '../json.ts'
import { lockNodeSource, revalidateNodeSource, nodeAllowsNewExecutionSQL } from '../nodes.ts'
import {
  lockProjectAgent,
  projectDecode,
  projectError,
  projectTransaction,
  recoveryWorkSQL,
  type ProjectBinding,
} from './store.ts'
import {
  executeChange,
  planChange,
  recall,
  readProjectMemory,
  sourcePage,
  hashText,
  pendingEmbeddings,
  commitEmbedding,
  deferEmbedding,
  embeddingText,
} from './memory/index.ts'

export const registerMemoryJob = Effect.fnUntraced(function* (b: ProjectBinding, through: number) {
  const sql = yield* SqlClient.SqlClient
  const [input] = yield* sql<{
    seq: number
  }>`SELECT max(seq)::float8 AS seq FROM conversation_events WHERE conversation_id=${b.conversationId} AND kind='input' AND seq<${through}`
  if (!input?.seq) return
  yield* sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq,source_ids)
 SELECT ${randomUUID()},${b.employeeId},${b.projectId},${b.conversationId},'consolidation',${input.seq},${through},COALESCE(array_agg(id ORDER BY source_seq,input_id NULLS LAST,id),'{}'::uuid[]) FROM project_memory_sources WHERE employee_id=${b.employeeId} AND project_id=${b.projectId} AND source_seq BETWEEN ${input.seq} AND ${through}
 ON CONFLICT DO NOTHING`
})

// 进程占用继续由 agent_runs.stop_acked_at 表示，撤销 claim 不释放设备容量。
export const releaseMemoryAttempt = Effect.fnUntraced(function* (jobId: string, reason: string, retry = false) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE agent_runs r SET state='finished',ended_at=clock_timestamp(),end_reason=${reason},stop_requested_at=COALESCE(stop_requested_at,clock_timestamp()),command_next_at=clock_timestamp(),command_attempts=0 FROM project_memory_jobs j WHERE j.id=${jobId} AND r.id=j.attempt_id AND r.stop_requested_at IS NULL`
  yield* sql`UPDATE project_memory_jobs j SET state=CASE WHEN p.status='archived' THEN 'cancelled' WHEN j.state='completed' THEN 'completed' ELSE 'pending' END,attempt_id=NULL,waiting_reason=${reason},last_error=CASE WHEN ${retry} THEN ${reason} ELSE last_error END,attempts=attempts+CASE WHEN ${retry} THEN 1 ELSE 0 END,next_attempt_at=clock_timestamp()+CASE WHEN NOT ${retry} THEN interval '0 seconds' WHEN attempts=0 THEN interval '1 minute' WHEN attempts=1 THEN interval '5 minutes' ELSE interval '15 minutes' END,updated_at=clock_timestamp() FROM projects p WHERE j.id=${jobId} AND p.id=j.project_id`
})
export const stopProjectMemory = Effect.fnUntraced(function* (projectId: string, reason: string) {
  const sql = yield* SqlClient.SqlClient
  const jobs = yield* sql<{
    id: string
  }>`SELECT id FROM project_memory_jobs WHERE project_id=${projectId} AND state IN ('pending','claimed','running') ORDER BY id`
  for (const job of jobs) yield* releaseMemoryAttempt(job.id, reason)
})

// 在前台放置事务之前撤销后台；前台会等实际停止回执后取得名额。
export const yieldMemoryToForeground = Effect.fnUntraced(function* (agentId: string) {
  yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const jobs = yield* sql<{
        id: string
        project_id: string
        employee_id: string
      }>`SELECT j.id,j.project_id,j.employee_id FROM project_memory_jobs j WHERE j.state IN ('claimed','running') AND EXISTS(SELECT 1 FROM project_agents a JOIN conversations c ON c.agent_id=a.id WHERE a.id=${agentId} AND a.employee_id=j.employee_id AND ${recoveryWorkSQL(sql)}) ORDER BY j.project_id`
      for (const j of jobs) {
        yield* lockProjectAgent(j.employee_id, j.project_id)
        yield* releaseMemoryAttempt(j.id, 'foreground_priority')
      }
    }),
  )
})

export const scheduleMemoryJobs = Effect.fn('scheduleMemoryJobs')(function* () {
  yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Embedding 工作不需要聊天登录；只在有到期待生成向量时登记。
      yield* sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq)
 SELECT gen_random_uuid(),p.employee_id,p.id,c.id,'embedding',0,0 FROM projects p JOIN project_agents a ON a.project_id=p.id JOIN conversations c ON c.agent_id=a.id WHERE p.status='active' AND EXISTS(SELECT 1 FROM project_memory_embeddings v JOIN project_memory_items e ON e.id=v.item_id WHERE v.project_id=p.id AND v.config_id::text=p.memory_embedding->>'config_id' AND v.revision=e.current_revision AND e.status IN ('active','superseded') AND v.state='pending' AND v.next_attempt_at<=clock_timestamp())
 ON CONFLICT(conversation_id,kind,input_seq,policy_version) DO UPDATE SET state=CASE WHEN project_memory_jobs.state='completed' THEN 'pending' ELSE project_memory_jobs.state END`
      const jobs = yield* sql<{
        id: string
        employee_id: string
        project_id: string
      }>`SELECT id,employee_id,project_id FROM project_memory_jobs WHERE state IN ('pending','claimed','running') ORDER BY CASE WHEN kind='consolidation' THEN 0 ELSE 1 END,input_seq,id LIMIT 32`
      for (const job of jobs) {
        const locked =
          yield* sql`SELECT id FROM project_agents WHERE project_id=${job.project_id} FOR NO KEY UPDATE SKIP LOCKED`
        if (!locked.length) continue
        const [j] = yield* sql<{
          kind: string
          state: string
          status: string
          due: boolean
          valid: boolean
          configured: boolean
          provider: string
          source_node_id: string | null
          model: string
        }>`SELECT j.kind,j.state,p.status,j.next_attempt_at<=clock_timestamp() AS due,COALESCE(r.memory_claim_until>clock_timestamp() AND r.provider=a.provider AND r.model=a.model AND (j.kind<>'consolidation' OR a.source_node_id IS NULL OR r.node_id=a.source_node_id) AND EXISTS(SELECT 1 FROM nodes n JOIN node_credentials nc ON nc.node_id=n.id AND nc.version=n.credential_version WHERE n.id=r.node_id AND n.revoked_at IS NULL AND nc.revoked_at IS NULL AND nc.expires_at>clock_timestamp()),false) AS valid,p.memory_embedding IS NOT NULL AS configured,a.provider,a.model,a.source_node_id FROM project_memory_jobs j JOIN projects p ON p.id=j.project_id JOIN project_agents a ON a.project_id=p.id LEFT JOIN agent_runs r ON r.id=j.attempt_id WHERE j.id=${job.id}`
        if (!j) continue
        if (j.state !== 'pending') {
          if (j.status !== 'active' || !j.valid || (j.kind === 'embedding' && !j.configured))
            yield* releaseMemoryAttempt(job.id, j.status !== 'active' ? `project_${j.status}` : 'claim_expired')
          continue
        }
        if (j.status !== 'active' || !j.due) continue
        // 整理按批次顺序执行；永久停放的批次不阻塞后续批次。
        if (j.kind === 'consolidation') {
          const earlier =
            yield* sql`SELECT 1 FROM project_memory_jobs WHERE project_id=${job.project_id} AND kind='consolidation' AND input_seq<(SELECT input_seq FROM project_memory_jobs WHERE id=${job.id}) AND state NOT IN ('completed','cancelled') AND next_attempt_at<>'infinity' LIMIT 1`
          if (earlier.length) continue
        }
        const foreground =
          yield* sql`SELECT 1 FROM project_agents a JOIN conversations c ON c.agent_id=a.id JOIN projects p ON p.id=a.project_id WHERE a.employee_id=${job.employee_id} AND p.status='active' AND (a.lease_run_id IS NOT NULL OR ${recoveryWorkSQL(sql)}) LIMIT 1`
        if (foreground.length) {
          yield* sql`UPDATE project_memory_jobs SET waiting_reason='foreground_priority' WHERE id=${job.id}`
          continue
        }
        const busy =
          yield* sql`SELECT 1 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id WHERE a.project_id=${job.project_id} AND r.memory_job_id IS NOT NULL AND r.stop_acked_at IS NULL LIMIT 1`
        if (busy.length) continue
        const nodes = yield* sql<{
          id: string
          report: P.RuntimeReport
        }>`SELECT n.id,r.report FROM nodes n JOIN node_presence np ON np.node_id=n.id JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.employee_id=${job.employee_id} AND n.revoked_at IS NULL AND np.online AND np.synced AND ${nodeAllowsNewExecutionSQL(sql)} AND EXISTS(SELECT 1 FROM node_credentials nc WHERE nc.node_id=n.id AND nc.version=n.credential_version AND nc.revoked_at IS NULL AND nc.expires_at>clock_timestamp()) ORDER BY n.registration_seq FOR UPDATE OF n`
        let chosen = '',
          waiting = 'device_unavailable'
        for (const node of nodes) {
          if (j.kind === 'consolidation' && j.source_node_id && node.id !== j.source_node_id) continue
          const valid =
            yield* sql`SELECT 1 FROM node_credentials nc JOIN nodes n ON n.id=nc.node_id WHERE n.id=${node.id} AND n.revoked_at IS NULL AND ${nodeAllowsNewExecutionSQL(sql)} AND nc.version=n.credential_version AND nc.revoked_at IS NULL AND nc.expires_at>clock_timestamp()`
          if (!valid.length) continue
          if (node.report.project_runtime?.memory_protocol !== 1) {
            waiting = 'memory_protocol_missing'
            continue
          }
          if (
            j.kind === 'consolidation' &&
            !node.report.project_runtime.providers?.some(
              (p) => p.provider === j.provider && p.status !== 'login_required',
            )
          ) {
            waiting = 'login_required'
            continue
          }
          const occupied =
            yield* sql`SELECT 1 FROM agent_runs WHERE node_id=${node.id} AND stop_acked_at IS NULL LIMIT 1`
          if (occupied.length) {
            waiting = 'device_busy'
            continue
          }
          chosen = node.id
          break
        }
        if (!chosen) {
          yield* sql`UPDATE project_memory_jobs SET waiting_reason=${waiting} WHERE id=${job.id}`
          continue
        }
        const attempt = randomUUID()
        const [claimed] = yield* sql<{
          claim_epoch: number
        }>`UPDATE project_memory_jobs SET state='claimed',attempt_id=${attempt},claim_epoch=claim_epoch+1,waiting_reason='',updated_at=clock_timestamp() WHERE id=${job.id} AND state='pending' RETURNING claim_epoch::float8 AS claim_epoch`
        if (!claimed) continue
        yield* sql`INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason,memory_job_id,memory_claim_until) SELECT ${attempt},${job.employee_id},id,${chosen},${claimed.claim_epoch},'starting',${j.provider},${j.model},'memory_idle',${job.id},clock_timestamp()+interval '60 seconds' FROM project_agents WHERE project_id=${job.project_id}`
      }
    }),
  )
})

const Cursor = { cursor_index: P.NonNegativeInteger, cursor_offset: P.NonNegativeInteger }
const Proposal = Schema.Struct({
  item_id: Schema.optionalKey(P.UUID),
  expected_revision: P.NonNegativeInteger,
  action: Schema.Literals(['add', 'support', 'correct', 'supersede', 'dispute']),
  content: Schema.optionalKey(P.MemoryContent),
  evidence: Schema.Array(P.MemoryEvidence),
  reason: Schema.optionalKey(P.boundedText(8192)),
})
const Chunk = Schema.Struct({
  ...Cursor,
  changes: Schema.Array(Proposal).check(Schema.isMaxLength(16)),
  // 未置位时，任一提案遇到修订冲突会撤回整片，让 Runtime 用最新条目重新整理一次。
  final: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(Schema.Json),
})
type Outcome = { index: number; item_id: string; revision: number } | { index: number; rejected: string }
const operationId = (identity: string) => {
  const h = createHash('sha256').update(identity).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
interface Job {
  id: string
  employee_id: string
  project_id: string
  kind: string
  provider: string
  model: string
  input_seq: number
  through_seq: number
  cursor_index: number
  cursor_offset: number
  source_ids: string[]
  state: string
  attempts: number
}
const readChunk = Effect.fnUntraced(function* (j: Job) {
  const id = j.source_ids[j.cursor_index]
  if (!id) return { done: true as const, cursor_index: j.cursor_index, cursor_offset: j.cursor_offset }
  const source = yield* sourcePage(j.employee_id, j.project_id, id, j.cursor_offset, 32 * 1024)
  return { done: false as const, cursor_index: j.cursor_index, cursor_offset: j.cursor_offset, source }
})
// 这些失败与分片内容有关；同一分片连续第三次失败时跳过它并记录原因，后续批次不再被它阻塞。
const CHUNK_FAILURES = [
  'invalid_memory_response',
  'invalid_evidence',
  'too_large',
  'model_call_budget_exhausted',
  'no_progress',
]
const skipChunk = Effect.fnUntraced(function* (j: Job, attemptId: string, reason: string) {
  const sql = yield* SqlClient.SqlClient
  const page = yield* readChunk(j)
  if (page.done) return
  const nextIndex = j.cursor_index + (page.source.has_more ? 0 : 1),
    nextOffset = page.source.has_more ? page.source.next_offset : 0,
    done = nextIndex >= j.source_ids.length
  const result = { cursor_index: nextIndex, cursor_offset: nextOffset, done, outcomes: [], skipped: reason }
  yield* sql`INSERT INTO project_memory_chunks(job_id,cursor_index,cursor_offset,attempt_id,request_hash,result) VALUES(${j.id},${j.cursor_index},${j.cursor_offset},${attemptId},'',${JSON.stringify(result)}::jsonb)`
  yield* sql`UPDATE project_memory_jobs SET cursor_index=${nextIndex},cursor_offset=${nextOffset},state=CASE WHEN ${done} THEN 'completed' ELSE state END,last_error=${reason},attempts=0,updated_at=clock_timestamp() WHERE id=${j.id}`
})
const CONTEXT_SOURCE_BYTES = 4096,
  CONTEXT_TOTAL_BYTES = 24 * 1024
// 同批次的其他来源和批次前最近一条助手回复，作为当前分片的只读上下文；每条从开头截取。
const readContext = Effect.fnUntraced(function* (j: Job, currentId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    id: string
    role: string
    source_type: string
    source_hash: string
    text: string
  }>`SELECT id,role,source_type,source_hash,text FROM project_memory_sources WHERE employee_id=${j.employee_id} AND project_id=${j.project_id} AND id<>${currentId} AND (id=ANY(${j.source_ids}::uuid[]) OR id=(SELECT id FROM project_memory_sources WHERE employee_id=${j.employee_id} AND project_id=${j.project_id} AND source_type='assistant' AND source_seq<${j.input_seq} ORDER BY source_seq DESC LIMIT 1)) ORDER BY COALESCE(array_position(${j.source_ids}::uuid[],id),0)`
  const context = []
  let total = 0
  for (const row of rows) {
    const bytes = Buffer.from(row.text)
    let end = Math.min(bytes.length, CONTEXT_SOURCE_BYTES, CONTEXT_TOTAL_BYTES - total)
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    if (end <= 0) break
    total += end
    context.push({ ...row, text: bytes.subarray(0, end).toString(), truncated: end < bytes.length })
  }
  return context
})
// 只返回未释放的停用和纠正断言，供整理避免重新写入。
const suppressedAssertions = Effect.fnUntraced(function* (j: Job) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{
    item_id: string
    revision: number
    kind: string
    title: string
    content: string
    conditions: string
    semantic_key: string
  }>`SELECT x.item_id,x.revision::float8 AS revision,x.kind,r.title,left(r.content,1024) AS content,r.conditions,r.semantic_key FROM project_memory_suppressions x JOIN project_memory_revisions r ON r.item_id=x.item_id AND r.revision=x.revision WHERE x.employee_id=${j.employee_id} AND x.project_id=${j.project_id} AND x.released_at IS NULL ORDER BY x.created_at DESC LIMIT 32`
})
export const memoryRuntimeRequest = Effect.fn('memoryRuntimeRequest')(function* (
  source: NodeSource,
  request: P.ProjectRuntimeRequest,
) {
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [owner] = yield* sql<{
        project_id: string
      }>`SELECT a.project_id FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id WHERE r.id=${request.run_id} AND r.employee_id=${source.employee_id} AND r.node_id=${source.node_id} AND r.memory_job_id IS NOT NULL`
      if (!owner) return yield* Effect.fail(projectError('claim_lost'))
      yield* lockProjectAgent(source.employee_id, owner.project_id)
      yield* lockNodeSource(source)
      if (['stopped', 'exited'].includes(request.operation)) {
        const [r] = yield* sql<{
          memory_job_id: string
          stopped: boolean
        }>`SELECT memory_job_id,stop_requested_at IS NOT NULL AS stopped FROM agent_runs WHERE id=${request.run_id} AND lease_epoch=${request.lease_epoch}`
        if (!r) return yield* Effect.fail(projectError('claim_lost'))
        if (!r.stopped) yield* releaseMemoryAttempt(r.memory_job_id, 'runtime_exited', true)
        if (request.operation === 'stopped')
          yield* sql`UPDATE agent_runs SET stop_acked_at=COALESCE(stop_acked_at,clock_timestamp()) WHERE id=${request.run_id}`
        yield* revalidateNodeSource(source)
        return {}
      }
      const [j] =
        yield* sql<Job>`SELECT j.id,j.employee_id,j.project_id,j.kind,r.provider,r.model,j.input_seq::float8 AS input_seq,j.through_seq::float8 AS through_seq,j.cursor_index,j.cursor_offset,j.source_ids,j.state,j.attempts FROM project_memory_jobs j JOIN agent_runs r ON r.id=j.attempt_id JOIN projects p ON p.id=j.project_id WHERE r.id=${request.run_id} AND r.lease_epoch=${request.lease_epoch} AND j.claim_epoch=${request.lease_epoch} AND r.memory_claim_until>clock_timestamp() AND r.stop_requested_at IS NULL AND p.status='active' AND j.state IN ('claimed','running','completed')`
      if (!j) return yield* Effect.fail(projectError('claim_lost'))
      let result: unknown = {}
      switch (request.operation) {
        case 'started':
        case 'renew':
          yield* sql`UPDATE agent_runs SET state=CASE WHEN ${request.operation === 'started'} THEN 'running' ELSE state END,memory_claim_until=clock_timestamp()+interval '60 seconds' WHERE id=${request.run_id}`
          yield* sql`UPDATE project_memory_jobs SET state=CASE WHEN state='completed' OR NOT ${request.operation === 'started'} THEN state ELSE 'running' END WHERE id=${j.id}`
          result = { lease_seconds: 60 }
          break
        case 'memory_bootstrap':
          result = {
            job_id: j.id,
            kind: j.kind,
            provider: j.provider,
            model: j.model,
            max_model_calls: 8,
            max_duration_ms: 300000,
            max_changes: 16,
            cursor_index: j.cursor_index,
            cursor_offset: j.cursor_offset,
          }
          break
        case 'read_sources':
          if (j.kind !== 'consolidation') return yield* Effect.fail(projectError('invalid', 422))
          const page = yield* readChunk(j)
          result = page.done ? page : { ...page, context: yield* readContext(j, page.source.id) }
          break
        case 'lookup_items': {
          const q = yield* projectDecode(P.MemoryRecallInput, request.payload)
          const matches = yield* recall(j.employee_id, j.project_id, q)
          const items = []
          for (const hit of matches.entries)
            if (hit.item) items.push(yield* readProjectMemory(j.employee_id, j.project_id, hit.item.id))
          result = { matches, items, suppressed: yield* suppressedAssertions(j) }
          break
        }
        case 'commit_chunk': {
          if (j.kind !== 'consolidation') return yield* Effect.fail(projectError('invalid', 422))
          const chunk = yield* projectDecode(Chunk, request.payload)
          const hash = hashText(canonical(chunk))
          const [saved] = yield* sql<{
            request_hash: string
            result: unknown
          }>`SELECT request_hash,result FROM project_memory_chunks WHERE job_id=${j.id} AND cursor_index=${chunk.cursor_index} AND cursor_offset=${chunk.cursor_offset}`
          if (saved) {
            if (saved.request_hash !== hash) return yield* Effect.fail(projectError('operation_conflict'))
            result = saved.result
            break
          }
          if (chunk.cursor_index !== j.cursor_index || chunk.cursor_offset !== j.cursor_offset)
            return yield* Effect.fail(projectError('job_cursor_conflict'))
          const page = yield* readChunk(j)
          if (page.done) {
            result = { done: true }
            break
          }
          const visible = new Map([
            [
              page.source.id,
              { hash: page.source.source_hash, start: page.source.offset, end: page.source.next_offset },
            ],
            ...(yield* readContext(j, page.source.id)).map(
              (c) => [c.id, { hash: c.source_hash, start: 0, end: Buffer.byteLength(c.text) }] as const,
            ),
          ])
          // 每条提案单独校验；被拒的提案记录原因，不阻止同片其他提案和游标推进。
          const outcomes: Outcome[] = []
          for (const [index, change] of chunk.changes.entries()) {
            const rejected = page.source.suppressed
              ? 'source_suppressed'
              : !change.evidence.some((e) => e.source_id === page.source.id) ||
                  change.evidence.some((e) => {
                    const v = visible.get(e.source_id)
                    return !v || e.source_hash !== v.hash || e.start_byte < v.start || e.end_byte > v.end
                  })
                ? 'invalid_evidence'
                : change.content && Buffer.byteLength(JSON.stringify(change.content)) > 8192
                  ? 'too_large'
                  : undefined
            if (rejected) {
              outcomes.push({ index, rejected })
              continue
            }
            const plan = yield* Effect.result(
              planChange(
                j.employee_id,
                j.project_id,
                { type: 'background', throughSeq: j.through_seq },
                { ...change, operation_id: operationId(`${j.id}:${j.cursor_index}:${j.cursor_offset}:${index}`) },
              ),
            )
            if (Result.isFailure(plan)) {
              const error = plan.failure
              if (!(error instanceof AppError) || error.status >= 500 || error.code === 'project_archived')
                return yield* Effect.fail(error)
              if (error.code === 'memory_conflict' && !chunk.final) return yield* Effect.fail(error)
              outcomes.push({ index, rejected: error.code })
              continue
            }
            const item = yield* executeChange(plan.success)
            outcomes.push({ index, item_id: item.id, revision: item.revision })
          }
          const nextIndex = j.cursor_index + (page.source.has_more ? 0 : 1),
            nextOffset = page.source.has_more ? page.source.next_offset : 0
          result = {
            cursor_index: nextIndex,
            cursor_offset: nextOffset,
            done: nextIndex >= j.source_ids.length,
            outcomes,
          }
          yield* sql`INSERT INTO project_memory_chunks(job_id,cursor_index,cursor_offset,attempt_id,request_hash,result) VALUES(${j.id},${j.cursor_index},${j.cursor_offset},${request.run_id},${hash},${JSON.stringify(result)}::jsonb)`
          yield* sql`UPDATE project_memory_jobs SET cursor_index=${nextIndex},cursor_offset=${nextOffset},state=CASE WHEN ${nextIndex >= j.source_ids.length} THEN 'completed' ELSE state END,usage=${chunk.usage ? JSON.stringify(chunk.usage) : null}::jsonb,last_error='',attempts=0,updated_at=clock_timestamp() WHERE id=${j.id}`
          break
        }
        case 'pending_embeddings': {
          if (j.kind !== 'embedding') return yield* Effect.fail(projectError('invalid', 422))
          const pending = yield* pendingEmbeddings(j.employee_id, j.project_id, 1)
          const entries = []
          for (const entry of pending.entries) {
            const item = yield* readProjectMemory(j.employee_id, j.project_id, entry.item_id)
            entries.push({ ...entry, text: embeddingText(item) })
          }
          result = { ...pending, entries }
          break
        }
        case 'commit_embedding': {
          if (j.kind !== 'embedding') return yield* Effect.fail(projectError('invalid', 422))
          const input = yield* projectDecode(
            Schema.Struct({ ...P.MemoryEmbeddingCommit.fields, usage: Schema.optionalKey(Schema.Json) }),
            request.payload,
          )
          result = yield* commitEmbedding(j.employee_id, j.project_id, input)
          yield* sql`UPDATE project_memory_jobs SET usage=${input.usage ? JSON.stringify(input.usage) : null}::jsonb,updated_at=clock_timestamp() WHERE id=${j.id}`
          break
        }
        case 'defer_embedding': {
          if (j.kind !== 'embedding') return yield* Effect.fail(projectError('invalid', 422))
          const input = yield* projectDecode(
            Schema.Struct({
              ...P.MemoryEmbeddingCommit.fields,
              vector: Schema.optionalKey(P.EmbeddingVector),
              diagnostic: Schema.Literals([
                'credential_missing',
                'embedding_request_failed',
                'embedding_timeout',
                'embedding_unavailable',
              ]),
            }),
            request.payload,
          )
          yield* deferEmbedding(j.employee_id, j.project_id, input, input.diagnostic)
          break
        }
        case 'finish': {
          // 未完成且本次尝试没有提交任何分片时退避重试，避免同一片反复失败时占住后续批次。
          const [state] = yield* sql<{
            completed: boolean
            progressed: boolean
          }>`UPDATE project_memory_jobs SET state=CASE WHEN kind='embedding' OR cursor_index>=cardinality(source_ids) THEN 'completed' ELSE state END WHERE id=${j.id} RETURNING state='completed' AS completed,EXISTS(SELECT 1 FROM project_memory_chunks WHERE job_id=${j.id} AND attempt_id=${request.run_id}) AS progressed`
          const stalled = !state!.completed && !state!.progressed
          if (stalled && j.kind === 'consolidation' && j.attempts >= 2) {
            yield* skipChunk(j, request.run_id, 'no_progress')
            yield* releaseMemoryAttempt(j.id, 'chunk_skipped')
          } else yield* releaseMemoryAttempt(j.id, stalled ? 'no_progress' : 'attempt_finished', stalled)
          break
        }
        case 'start_failed':
        case 'report_failure': {
          const reason = request.reason ?? 'memory_unavailable'
          const retry = [
            'model_request_failed',
            'model_call_budget_exhausted',
            'embedding_request_failed',
            'embedding_timeout',
            'unavailable',
            'runtime_exited',
            'invalid_memory_response',
            'invalid_evidence',
            'too_large',
          ].includes(reason)
          if (j.kind === 'consolidation' && CHUNK_FAILURES.includes(reason) && j.attempts >= 2) {
            yield* skipChunk(j, request.run_id, reason)
            yield* releaseMemoryAttempt(j.id, 'chunk_skipped')
            break
          }
          yield* releaseMemoryAttempt(j.id, reason, retry)
          if (!retry && reason !== 'login_required')
            yield* sql`UPDATE project_memory_jobs SET next_attempt_at='infinity',last_error=${reason} WHERE id=${j.id}`
          break
        }
        default:
          return yield* Effect.fail(projectError('invalid', 422))
      }
      yield* revalidateNodeSource(source)
      if (Buffer.byteLength(JSON.stringify(result)) > 190 * 1024)
        return yield* Effect.fail(projectError('too_large', 413))
      return result
    }),
  )
})
