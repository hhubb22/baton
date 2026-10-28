import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { dbError } from '../database.ts'
import { canonical } from '../json.ts'
import { normalizeProjectMessage } from './message-reference.ts'
import { insertProjectInput } from './inputs.ts'
import { embeddingConfiguration, queueEmbeddings, lockMemoryState } from './memory/index.ts'
import {
  boundedProjectText,
  decodeProjectEvent,
  checkPayloadSize,
  eventSelection,
  lockProjectAgent,
  projectDecode,
  projectError,
  projectSelection,
  projectTransaction,
  readProject,
  releaseProjectRun,
} from './store.ts'

export { runtimeRequest } from './runtime.ts'
export { projectStatus } from './view.ts'
export { listProjectRunCandidates, scheduleProjectRun, claimProjectCommands } from './scheduling.ts'
export { scheduleMemoryJobs } from './memory-jobs.ts'
import { stopProjectMemory } from './memory-jobs.ts'
import * as threads from '../threads/index.ts'

export const getProject = Effect.fn('getProject')(function* (employee: string, project: string) {
  yield* projectDecode(P.UUID, project)
  return yield* readProject(employee, project)
}, Effect.mapError(dbError))
export const createProject = Effect.fn('createProject')(function* (employee: string, input: P.CreateProjectInput) {
  const decoded = yield* projectDecode(P.CreateProjectInput, input)
  yield* projectDecode(P.summary(1024), decoded.provider)
  yield* projectDecode(P.summary(1024), decoded.model)
  const clientId = decoded.client_project_id ? yield* projectDecode(P.UUID, decoded.client_project_id) : null
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const id = randomUUID(),
        agent = randomUUID(),
        conversation = randomUUID()
      const memoryEmbedding = embeddingConfiguration(null, decoded.memory_embedding ?? null)
      const rows =
        yield* sql`INSERT INTO projects(id,employee_id,title,goal,memory_embedding,client_project_id,create_request)
 VALUES(${id},${employee},${decoded.title},${decoded.goal ?? ''},${memoryEmbedding ? JSON.stringify(memoryEmbedding) : null}::jsonb,${clientId},${JSON.stringify(decoded)}::jsonb)
 ON CONFLICT(employee_id,client_project_id) DO NOTHING RETURNING id`
      if (!rows.length) {
        const [old] = yield* sql<{
          id: string
          matches: boolean
        }>`SELECT id,create_request=${JSON.stringify(decoded)}::jsonb AS matches FROM projects WHERE employee_id=${employee} AND client_project_id=${clientId}`
        if (!old?.matches) return yield* Effect.fail(projectError('project_conflict'))
        return yield* readProject(employee, old.id)
      }
      yield* sql`INSERT INTO project_agents(id,employee_id,project_id,provider,model) VALUES(${agent},${employee},${id},${decoded.provider},${decoded.model})`
      yield* sql`INSERT INTO conversations(id,employee_id,agent_id) VALUES(${conversation},${employee},${agent})`
      return yield* readProject(employee, id)
    }),
  )
})
export const listProjects = Effect.fn('listProjects')(function* (employee: string, afterId = '', limit = 50) {
  const sql = yield* SqlClient.SqlClient
  if (afterId) yield* projectDecode(P.UUID, afterId)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* Effect.fail(projectError('invalid', 422))
  const rows = yield* sql<{
    value: unknown
  }>`SELECT ${projectSelection(sql)} AS value FROM projects p JOIN project_agents a ON a.project_id=p.id AND a.employee_id=p.employee_id
 JOIN conversations c ON c.agent_id=a.id AND c.employee_id=a.employee_id WHERE p.employee_id=${employee} AND (${afterId || null}::uuid IS NULL OR p.id>${afterId || null}::uuid) ORDER BY p.id LIMIT ${limit + 1}`
  const projects = yield* Effect.forEach(rows.slice(0, limit), (row) => projectDecode(P.Project, row.value))
  return { projects, ...(rows.length > limit ? { next_after_id: projects.at(-1)!.id } : {}) }
}, Effect.mapError(dbError))
export const patchProject = Effect.fn('patchProject')(function* (
  employee: string,
  id: string,
  input: P.PatchProjectInput,
) {
  const patch = yield* projectDecode(P.PatchProjectInput, input)
  yield* projectDecode(P.UUID, id)
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const agent = yield* lockProjectAgent(employee, id)
      const old = yield* readProject(employee, id)
      const value = yield* projectDecode(P.Project, {
        ...old,
        memory_embedding:
          patch.memory_embedding === undefined
            ? old.memory_embedding
            : embeddingConfiguration(old.memory_embedding, patch.memory_embedding),
        title: patch.title ?? old.title,
        goal: patch.goal ?? old.goal,
        status: patch.status ?? old.status,
        agent: { ...old.agent, provider: patch.provider ?? old.agent.provider, model: patch.model ?? old.agent.model },
      })
      yield* projectDecode(P.summary(1024), value.agent.provider)
      yield* projectDecode(P.summary(1024), value.agent.model)
      yield* sql`UPDATE projects SET memory_embedding=${value.memory_embedding ? JSON.stringify(value.memory_embedding) : null}::jsonb,title=${value.title},goal=${value.goal},status=${value.status},version=version+1,updated_at=clock_timestamp() WHERE id=${id} AND employee_id=${employee}`
      yield* sql`UPDATE project_agents SET provider=${value.agent.provider},model=${value.agent.model} WHERE id=${agent}`
      if (old.memory_embedding?.config_id !== value.memory_embedding?.config_id) {
        yield* lockMemoryState(employee, id)
        yield* queueEmbeddings(employee, id)
        yield* sql`UPDATE project_memory_state SET search_generation=search_generation+1 WHERE employee_id=${employee} AND project_id=${id}`
      }
      const updated = yield* readProject(employee, id)
      if (updated.title !== old.title || updated.goal !== old.goal) {
        let limit = Math.min(Buffer.byteLength(updated.goal), 3 * 1024)
        let payload
        do {
          payload = {
            title: updated.title,
            goal: boundedProjectText(updated.goal, limit),
            version: updated.version,
            original_goal_bytes: Buffer.byteLength(updated.goal),
            truncated: Buffer.byteLength(updated.goal) > limit,
          }
          limit = Math.floor(limit * 0.75)
        } while (Buffer.byteLength(JSON.stringify(payload)) + 128 > 4096)
        yield* insertProjectInput(
          employee,
          agent,
          'project_updated',
          `project:${id}:version:${updated.version}`,
          payload,
        )
      }
      if (updated.status === 'archived')
        yield* sql`UPDATE attention_requests SET state='withdrawn',withdraw_reason='Project 已归档',version=version+1,updated_at=clock_timestamp() WHERE project_id=${id} AND employee_id=${employee} AND state='open'`
      // 归档时为仍有工作的 Thread 保存停止请求，设备确认前 Thread 保持 stop_requested_at 未确认
      if (updated.status === 'archived' && old.status !== 'archived') {
        const running = yield* sql<{ id: string }>`SELECT t.id FROM threads t
          WHERE t.employee_id=${employee} AND t.project_id=${id} AND t.status<>'archived'
            AND (t.status IN ('waiting_device','running')
              OR EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=t.id AND v.ended_at IS NULL)
              OR EXISTS(SELECT 1 FROM thread_messages m WHERE m.thread_id=t.id AND m.status IN ('accepted','queued')))
          ORDER BY t.id`
        for (const thread of running) yield* threads.stop(employee, thread.id)
      }
      if (updated.status !== 'active') yield* releaseProjectRun(agent, 'finished', `project_${updated.status}`)
      if (
        updated.status !== 'active' ||
        updated.agent.provider !== old.agent.provider ||
        updated.agent.model !== old.agent.model ||
        updated.memory_embedding?.config_id !== old.memory_embedding?.config_id
      )
        yield* stopProjectMemory(
          id,
          updated.status !== 'active' ? `project_${updated.status}` : 'configuration_changed',
        )
      return updated
    }),
  )
})
export const acceptProjectMessage = Effect.fn('acceptProjectMessage')(function* (
  employee: string,
  project: string,
  input: P.ProjectMessageInput,
) {
  if (Buffer.byteLength(input.content) > 64 * 1024) return yield* Effect.fail(projectError('too_large', 413))
  const value = yield* projectDecode(P.ProjectMessageInput, input)
  const p = yield* getProject(employee, project)
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* lockProjectAgent(employee, project)
      const payload = { content: value.content, reference: value.reference ?? null },
        key = 'user:' + value.client_message_id
      yield* checkPayloadSize(payload, 72 * 1024)
      const inserted =
        yield* sql`INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash,wake_required)
 VALUES(${employee},${p.agent.id},'user_message',${key},${JSON.stringify(payload)}::jsonb,${createHash('sha256').update(canonical(payload)).digest()},true) ON CONFLICT(agent_id,source_key) DO NOTHING RETURNING id`
      if (inserted.length)
        yield* sql`UPDATE conversations SET next_attempt_at=NULL WHERE agent_id=${p.agent.id} AND state='active'`
      const [row] = yield* sql<{
        value: P.ProjectMessage
      }>`SELECT jsonb_build_object('id',id,'client_message_id',${value.client_message_id}::text,'content',payload->>'content','created_at',created_at) || CASE WHEN payload ? 'reference' THEN jsonb_build_object('reference',payload->'reference') ELSE '{}'::jsonb END AS value
 FROM project_agent_input_queue WHERE employee_id=${employee} AND agent_id=${p.agent.id} AND source_key=${key}`
      if (!row) return yield* Effect.fail(projectError('message_conflict'))
      const saved = normalizeProjectMessage(row.value)
      if (
        (row.value.content !== value.content ||
          canonical(row.value.reference ?? null) !== canonical(value.reference ?? null)) &&
        (saved.content !== value.content || canonical(saved.reference ?? null) !== canonical(value.reference ?? null))
      )
        return yield* Effect.fail(projectError('message_conflict'))
      return yield* projectDecode(P.ProjectMessage, saved)
    }),
  )
})
export const projectMessages = Effect.fn('projectMessages')(function* (
  employee: string,
  project: string,
  clientMessageId = '',
  afterId = 0,
  limit = 50,
) {
  const p = yield* getProject(employee, project),
    sql = yield* SqlClient.SqlClient
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return yield* Effect.fail(projectError('invalid', 422))
  const rows = yield* sql<{
    value: P.ProjectMessage
  }>`SELECT jsonb_build_object('id',id,'client_message_id',substring(source_key from 6),'content',payload->>'content','created_at',created_at) || CASE WHEN payload ? 'reference' THEN jsonb_build_object('reference',payload->'reference') ELSE '{}'::jsonb END AS value
 FROM project_agent_input_queue WHERE employee_id=${employee} AND agent_id=${p.agent.id} AND source_type='user_message' AND id>${afterId}
 AND ((${clientMessageId}='' AND delivered_seq IS NULL) OR (${clientMessageId}<>'' AND source_key='user:'||${clientMessageId})) ORDER BY id LIMIT ${limit + 1}`
  const messages = yield* Effect.forEach(rows.slice(0, limit), (row) =>
    projectDecode(P.ProjectMessage, normalizeProjectMessage(row.value)),
  )
  return { messages, ...(rows.length > limit ? { next_after_id: messages.at(-1)!.id } : {}) }
}, Effect.mapError(dbError))
export const projectEvents = Effect.fn('projectEvents')(function* (
  employee: string,
  project: string,
  afterSeq = 0,
  limit = 50,
) {
  const p = yield* getProject(employee, project),
    sql = yield* SqlClient.SqlClient
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return yield* Effect.fail(projectError('invalid', 422))
  const rows = yield* sql<{
    value: unknown
  }>`SELECT ${eventSelection(sql)} AS value FROM conversation_events e WHERE employee_id=${employee} AND conversation_id=${p.conversation.id} AND seq>${afterSeq} AND seq<=${p.conversation.last_seq} ORDER BY seq LIMIT ${limit}`
  const events: P.ProjectEvent[] = []
  let size = 0
  for (const row of rows) {
    const event = yield* decodeProjectEvent(row.value),
      bytes = Buffer.byteLength(JSON.stringify(event))
    if (events.length && size + bytes > 192 * 1024) break
    events.push(event)
    size += bytes
  }
  const next = events.at(-1)?.seq ?? afterSeq
  return { events, last_seq: p.conversation.last_seq, next_after_seq: next, has_more: next < p.conversation.last_seq }
}, Effect.mapError(dbError))
export const stopProject = Effect.fn('stopProject')(function* (employee: string, id: string) {
  yield* projectDecode(P.UUID, id)
  return yield* projectTransaction(
    Effect.gen(function* () {
      const agent = yield* lockProjectAgent(employee, id)
      yield* releaseProjectRun(agent, 'finished', 'user_stopped')
      return { ok: true as const }
    }),
  )
})
export const retryProject = Effect.fn('retryProject')(function* (employee: string, id: string) {
  yield* projectDecode(P.UUID, id)
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        agent = yield* lockProjectAgent(employee, id)
      yield* sql`UPDATE conversations SET state='active',failure_count=0,next_attempt_at=NULL,attention_reason=NULL WHERE agent_id=${agent}`
      yield* sql`UPDATE attention_requests SET state='resolved',version=version+1,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE employee_id=${employee} AND project_id=${id} AND source='system' AND state='open'`
      return { ok: true as const }
    }),
  )
})
