import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from '../../errors.ts'
import { canonical } from '../../json.ts'
import { transaction } from '../../database.ts'
import { insertProjectInput } from '../inputs.ts'
import { readProjectMemory, requireProject } from './read.ts'
import { hashText, saveSource, validateEvidence } from './sources.ts'
import { projectMemoryDocument } from './projection.ts'
import { queueEmbeddings } from './embeddings.ts'
import { estimatedTokens, MEMORY_HEADER, renderMemory } from './lexical.ts'

type Content = typeof P.MemoryContent.Type
export type MemoryActor = { type: 'employee' } | { type: 'foreground' | 'background'; throughSeq: number }
export interface MemoryChange {
  operation_id: string
  item_id?: string | undefined
  expected_revision: number
  action: typeof P.MemoryAction.Type
  content?: Content | undefined
  evidence?: readonly P.MemoryEvidence[]
  reason?: string
  suppression_id?: string
}
const normalized = (content: Content, previous?: P.ProjectMemory) => ({
  title: content.title,
  content: content.content,
  kind: content.kind ?? previous?.kind ?? 'fact',
  topic: content.topic ?? previous?.topic ?? '',
  conditions: content.conditions ?? previous?.conditions ?? '',
  semantic_key: content.semantic_key ?? previous?.semantic_key ?? '',
  core: content.core ?? previous?.core ?? false,
  valid_from: content.valid_from === undefined ? (previous?.valid_from ?? null) : content.valid_from,
  valid_until: content.valid_until === undefined ? (previous?.valid_until ?? null) : content.valid_until,
  time_precision: content.time_precision ?? previous?.time_precision ?? 'unknown',
})
const assertionHash = (c: { content: string; conditions: string; semantic_key: string }) =>
  hashText(canonical({ content: c.content, conditions: c.conditions, semantic_key: c.semantic_key }))
const uniqueEvidence = (refs: readonly P.MemoryEvidence[]) =>
  [...new Map(refs.map((ref) => [canonical(ref), ref])).values()].sort((a, b) =>
    canonical(a).localeCompare(canonical(b)),
  )

const suppress = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  item: P.ProjectMemory,
  kind: 'retired' | 'retracted',
) {
  const sql = yield* SqlClient.SqlClient
  const id = randomUUID()
  const retirementId = kind === 'retired' ? (item.suppression_id ?? id) : null
  yield* sql`INSERT INTO project_memory_suppressions(id,employee_id,project_id,item_id,revision,kind,retirement_id,semantic_key,value_hash,evidence) VALUES(${id},${employeeId},${projectId},${item.id},${item.revision},${kind},${retirementId},${item.semantic_key},${assertionHash(item)},${JSON.stringify(item.evidence)}::jsonb)`
})
const conflict = (current: P.ProjectMemory, code = 'memory_conflict') =>
  new AppError(409, code, '记忆已变化', { current, current_revision: current.revision })

type Normalized = ReturnType<typeof normalized>
type Status = P.ProjectMemory['status']
// 员工编辑的来源在执行时保存，计划阶段用同长度的占位 id 计算核心预算。
const PENDING_SOURCE = '00000000-0000-0000-0000-000000000000'

export interface MemoryChangePlan {
  employeeId: string
  projectId: string
  agentId: string
  actor: MemoryActor
  change: MemoryChange
  requestHash: string
  replay?: P.ProjectMemory
  previous?: P.ProjectMemory | undefined
  id: string
  revision: number
  status: Status
  content: Normalized
  evidence: readonly P.MemoryEvidence[]
  basis: string
  revisionBasis: string
  sourceSeq: number | null
  edit?: string
  releaseRetirement?: string | null
  changed: boolean
}

// 调用方在事务内使用。只加锁、读取和校验，不写记忆数据，失败时不留下任何记录。
export const planChange = Effect.fn('planMemoryChange')(function* (
  employeeId: string,
  projectId: string,
  actor: MemoryActor,
  change: MemoryChange,
) {
  const sql = yield* SqlClient.SqlClient
  const binding = yield* requireProject(employeeId, projectId, true)
  if (binding.status === 'archived') return yield* Effect.fail(new AppError(409, 'project_archived'))
  yield* sql`INSERT INTO project_memory_state(employee_id,project_id) VALUES(${employeeId},${projectId}) ON CONFLICT DO NOTHING`
  yield* sql`SELECT 1 FROM project_memory_state WHERE employee_id=${employeeId} AND project_id=${projectId} FOR UPDATE`
  const requestHash = hashText(canonical({ actor, change }))
  const base = { employeeId, projectId, agentId: binding.agent_id, actor, change, requestHash }
  const [saved] = yield* sql<{
    request_hash: string
    result: P.ProjectMemory
  }>`SELECT request_hash,result FROM project_memory_changes WHERE employee_id=${employeeId} AND project_id=${projectId} AND operation_id=${change.operation_id}`
  if (saved) {
    if (saved.request_hash !== requestHash) return yield* Effect.fail(new AppError(409, 'operation_conflict'))
    const r = saved.result
    return {
      ...base,
      replay: r,
      id: r.id,
      revision: r.revision,
      status: r.status,
      content: normalized(r, r),
      evidence: r.evidence,
      basis: r.basis,
      revisionBasis: r.basis,
      sourceSeq: null,
      changed: false,
    } satisfies MemoryChangePlan
  }
  if (
    !Number.isSafeInteger(change.expected_revision) ||
    change.expected_revision < 0 ||
    change.expected_revision >= Number.MAX_SAFE_INTEGER
  )
    return yield* Effect.fail(new AppError(422, 'invalid'))
  let previous =
    change.item_id && change.expected_revision > 0
      ? yield* readProjectMemory(employeeId, projectId, change.item_id)
      : undefined
  if (change.item_id && !previous) {
    const [exists] = yield* sql<{
      employee_id: string
      project_id: string
    }>`SELECT employee_id,project_id FROM project_memory_items WHERE id=${change.item_id}`
    if (exists) {
      if (exists.employee_id !== employeeId || exists.project_id !== projectId)
        return yield* Effect.fail(new AppError(404, 'not_found'))
      return yield* Effect.fail(conflict(yield* readProjectMemory(employeeId, projectId, change.item_id)))
    }
  }
  if (previous && previous.revision !== change.expected_revision) return yield* Effect.fail(conflict(previous))
  if (change.action !== 'add' && !previous) return yield* Effect.fail(new AppError(404, 'not_found'))
  if (change.action === 'add' && previous) return yield* Effect.fail(conflict(previous))
  if (['add', 'correct', 'supersede'].includes(change.action) && !change.content)
    return yield* Effect.fail(new AppError(422, 'invalid'))
  const content = normalized(change.content ?? previous!, change.action === 'supersede' ? undefined : previous)
  if (content.valid_from && content.valid_until && Date.parse(content.valid_from) >= Date.parse(content.valid_until))
    return yield* Effect.fail(new AppError(422, 'invalid_fact_time'))
  if (
    change.action === 'supersede' &&
    (!content.valid_from ||
      !previous!.semantic_key ||
      content.semantic_key !== previous!.semantic_key ||
      content.conditions !== previous!.conditions ||
      (previous!.valid_from && Date.parse(content.valid_from) <= Date.parse(previous!.valid_from)) ||
      (previous!.valid_until && Date.parse(content.valid_from) > Date.parse(previous!.valid_until)))
  )
    return yield* Effect.fail(new AppError(422, 'invalid_successor'))
  if (change.action === 'supersede' && previous!.successor_id) return yield* Effect.fail(conflict(previous!))
  if (change.action === 'correct' && previous?.successor_id) {
    const successor = yield* readProjectMemory(employeeId, projectId, previous.successor_id)
    if (
      successor.valid_from &&
      (!content.valid_until || Date.parse(content.valid_until) > Date.parse(successor.valid_from))
    )
      return yield* Effect.fail(conflict(previous))
  }
  let evidence = uniqueEvidence(change.evidence ?? [])
  let edit: string | undefined
  let sources: readonly { role: string; source_seq: number | null }[]
  if (actor.type === 'employee') {
    edit = canonical({ action: change.action, ...content, reason: change.reason ?? '' })
    evidence = [
      { source_id: PENDING_SOURCE, start_byte: 0, end_byte: Buffer.byteLength(edit), source_hash: hashText(edit) },
    ]
    sources = [{ role: 'user', source_seq: null }]
  } else sources = yield* validateEvidence(employeeId, projectId, evidence, actor.throughSeq)
  if (
    actor.type === 'background' &&
    (['retire', 'restore'].includes(change.action) || !sources.some((s) => ['user', 'execution'].includes(s.role)))
  )
    return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
  const hasUser = sources.some((s) => s.role === 'user')
  if (['retire', 'restore'].includes(change.action) && !hasUser)
    return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
  const basis = hasUser ? 'explicit' : sources.every((s) => s.role === 'execution') ? 'observed' : 'inferred'
  if (
    previous?.basis === 'explicit' &&
    previous.kind === 'preference' &&
    ['correct', 'supersede'].includes(change.action) &&
    basis === 'inferred'
  )
    return yield* Effect.fail(new AppError(422, 'invalid_evidence', '助手推断不能覆盖用户明确偏好'))
  if (content.core && basis !== 'explicit') return yield* Effect.fail(new AppError(422, 'invalid_core_source'))
  const suppressions = yield* sql<{
    id: string
    item_id: string
    kind: string
    retirement_id: string | null
    value_hash: string
    evidence: readonly P.MemoryEvidence[]
  }>`SELECT id,item_id,kind,retirement_id,value_hash,evidence FROM project_memory_suppressions WHERE employee_id=${employeeId} AND project_id=${projectId} AND released_at IS NULL`
  const overlaps = (refs: readonly { source_id: string; start_byte: number; end_byte: number }[]) =>
    refs.some((old) =>
      evidence.some(
        (ref) => old.source_id === ref.source_id && old.start_byte < ref.end_byte && ref.start_byte < old.end_byte,
      ),
    )
  if (actor.type !== 'employee' && suppressions.some((s) => overlaps(s.evidence)))
    return yield* Effect.fail(new AppError(409, 'source_suppressed'))
  if (actor.type !== 'employee' && ['add', 'support'].includes(change.action)) {
    const replaced = yield* sql<{
      source_id: string
      start_byte: number
      end_byte: number
    }>`SELECT v.source_id,v.start_byte::float8 AS start_byte,v.end_byte::float8 AS end_byte FROM project_memory_evidence v JOIN project_memory_items e ON e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.successor_id IS NOT NULL`
    if (overlaps(replaced)) return yield* Effect.fail(new AppError(409, 'source_suppressed'))
  }
  // 已停用或纠正的断言可由员工重新写入，或由停用之后的用户原话重新确认。
  const hash = assertionHash(content)
  if (
    actor.type !== 'employee' &&
    ['add', 'support'].includes(change.action) &&
    suppressions.some((s) => s.value_hash === hash)
  ) {
    const [restated] = yield* sql<{
      ok: boolean
    }>`SELECT bool_and(EXISTS(SELECT 1 FROM project_memory_sources v WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.id=ANY(${evidence.map((r) => r.source_id)}::uuid[]) AND v.role='user' AND v.created_at>x.created_at)) AS ok FROM project_memory_suppressions x WHERE x.employee_id=${employeeId} AND x.project_id=${projectId} AND x.released_at IS NULL AND x.value_hash=${hash}`
    if (!restated?.ok) return yield* Effect.fail(new AppError(409, 'source_suppressed'))
  }
  let status: Status = previous?.status ?? 'active'
  let id = previous?.id ?? change.item_id ?? randomUUID()
  let revision = (previous?.revision ?? 0) + 1
  let releaseRetirement: string | null | undefined
  if (change.action === 'restore') {
    const retired = suppressions.find((s) => s.id === change.suppression_id && s.item_id === id && s.kind === 'retired')
    if (!retired || status !== 'retired') return yield* Effect.fail(new AppError(422, 'invalid_suppression'))
    const successors = yield* sql<{
      id: string
    }>`WITH RECURSIVE chain AS (SELECT successor_id AS id FROM project_memory_items WHERE employee_id=${employeeId} AND project_id=${projectId} AND id=${id} UNION ALL SELECT e.successor_id FROM project_memory_items e JOIN chain c ON c.id=e.id WHERE e.employee_id=${employeeId} AND e.project_id=${projectId}) SELECT e.id FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.id<>${id} AND (e.id IN (SELECT id FROM chain) OR (${content.semantic_key}<>'' AND r.semantic_key=${content.semantic_key} AND r.conditions=${content.conditions})) AND e.status IN ('active','superseded') AND (r.valid_from IS NULL OR r.valid_from<=now()) AND (r.valid_until IS NULL OR r.valid_until>now())`
    if (successors[0])
      return yield* Effect.fail(
        conflict(yield* readProjectMemory(employeeId, projectId, successors[0].id), 'memory_restore_conflict'),
      )
    releaseRetirement = retired.retirement_id
    status = previous!.successor_id ? 'superseded' : 'active'
  }
  if (change.action === 'retire') status = 'retired'
  if (change.action === 'dispute' && status !== 'retired' && status !== 'superseded') status = 'disputed'
  if (change.action === 'correct' && status === 'disputed') status = 'active'
  if (status === 'retired') content.core = false
  if (change.action === 'add') {
    const matches = yield* sql<{
      id: string
    }>`SELECT e.id FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.status IN ('active','superseded') AND r.content=${content.content} AND r.conditions=${content.conditions} AND r.semantic_key=${content.semantic_key} AND r.kind=${content.kind} AND r.valid_from IS NOT DISTINCT FROM ${content.valid_from}::timestamptz AND r.valid_until IS NOT DISTINCT FROM ${content.valid_until}::timestamptz ORDER BY e.id LIMIT 1`
    if (matches[0]) {
      previous = yield* readProjectMemory(employeeId, projectId, matches[0].id)
      id = previous.id
      revision = previous.revision + 1
      status = previous.status
      Object.assign(content, normalized(previous, previous))
    }
  }
  if (change.action === 'support' || (change.action === 'add' && previous)) {
    if (
      previous &&
      (assertionHash(content) !== assertionHash(previous) ||
        content.kind !== previous.kind ||
        (content.valid_from ? Date.parse(content.valid_from) : null) !==
          (previous.valid_from ? Date.parse(previous.valid_from) : null) ||
        (content.valid_until ? Date.parse(content.valid_until) : null) !==
          (previous.valid_until ? Date.parse(previous.valid_until) : null))
    )
      return yield* Effect.fail(new AppError(422, 'invalid_support'))
    evidence = uniqueEvidence([...(previous?.evidence ?? []), ...evidence])
    if (previous) Object.assign(content, normalized(previous, previous))
  } else if (previous && !['correct', 'supersede'].includes(change.action))
    evidence = uniqueEvidence([...previous.evidence, ...evidence])
  if (content.core) {
    const others = yield* sql<{
      id: string
    }>`SELECT e.id FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.id<>${id} AND e.status IN ('active','superseded') AND r.core`
    const existingCore = yield* Effect.forEach(others, ({ id: otherId }) =>
      readProjectMemory(employeeId, projectId, otherId),
    )
    const tokens =
      estimatedTokens(
        MEMORY_HEADER +
          [...existingCore.map(renderMemory), renderMemory({ ...content, id, revision, evidence })].join('\n'),
      ) + 4
    if (tokens > P.MEMORY_CONTEXT_DEFAULTS.core_tokens)
      return yield* Effect.fail(
        new AppError(
          422,
          'core_budget_exceeded',
          `核心要求需要约 ${tokens} token，预算为 ${P.MEMORY_CONTEXT_DEFAULTS.core_tokens}；已保存内容保持不变`,
        ),
      )
  }
  const same =
    previous &&
    canonical(normalized(previous, previous)) === canonical(content) &&
    previous.status === status &&
    canonical(uniqueEvidence(previous.evidence)) === canonical(evidence)
  return {
    ...base,
    previous,
    id,
    revision,
    status,
    content,
    evidence,
    basis,
    revisionBasis:
      (change.action === 'support' || change.action === 'add') &&
      previous &&
      (previous.basis === 'explicit' || basis === 'inferred')
        ? previous.basis
        : basis,
    sourceSeq: sources[0]?.source_seq ?? null,
    ...(edit === undefined ? {} : { edit }),
    ...(releaseRetirement === undefined ? {} : { releaseRetirement }),
    changed: !same,
  } satisfies MemoryChangePlan
})

// 写入 planChange 已校验的变更；须在同一事务和同一把记忆状态锁内调用。
export const executeChange = Effect.fn('executeMemoryChange')(function* (plan: MemoryChangePlan) {
  if (plan.replay) return plan.replay
  const sql = yield* SqlClient.SqlClient
  const { employeeId, projectId, actor, change, previous, content, status } = plan
  let { id, revision, evidence } = plan
  if (plan.edit !== undefined) {
    const sourceId = yield* saveSource(
      employeeId,
      projectId,
      `edit:${change.operation_id}`,
      'user_edit',
      'user',
      plan.edit,
    )
    evidence = uniqueEvidence(evidence.map((r) => (r.source_id === PENDING_SOURCE ? { ...r, source_id: sourceId } : r)))
  }
  const author = actor.type === 'employee' ? 'user' : actor.type === 'background' ? 'background' : 'agent'
  const writeRevision = Effect.fnUntraced(function* (
    itemId: string,
    rev: number,
    value: Normalized,
    state: Status,
    refs: readonly P.MemoryEvidence[],
    action: typeof P.MemoryAction.Type,
    revisionBasis: string,
  ) {
    yield* sql`INSERT INTO project_memory_revisions(item_id,employee_id,project_id,revision,title,content,kind,topic,conditions,semantic_key,core,basis,valid_from,valid_until,time_precision,author,source_seq,action,reason,status) VALUES(${itemId},${employeeId},${projectId},${rev},${value.title},${value.content},${value.kind},${value.topic},${value.conditions},${value.semantic_key},${value.core},${revisionBasis},${value.valid_from},${value.valid_until},${value.time_precision},${author},${plan.sourceSeq},${action},${change.reason ?? ''},${state})`
    for (const ref of uniqueEvidence(refs))
      yield* sql`INSERT INTO project_memory_evidence(employee_id,project_id,item_id,revision,source_id,start_byte,end_byte,source_hash) VALUES(${employeeId},${projectId},${itemId},${rev},${ref.source_id},${ref.start_byte},${ref.end_byte},${ref.source_hash})`
    yield* sql`UPDATE project_memory_items SET title=${value.title},current_revision=${rev},status=${state},updated_at=clock_timestamp() WHERE employee_id=${employeeId} AND project_id=${projectId} AND id=${itemId}`
  })
  if (plan.changed) {
    if (change.action === 'restore')
      yield* sql`UPDATE project_memory_suppressions SET released_at=clock_timestamp() WHERE employee_id=${employeeId} AND project_id=${projectId} AND item_id=${id} AND retirement_id=${plan.releaseRetirement ?? null} AND kind='retired' AND released_at IS NULL`
    if (
      change.action === 'correct' &&
      previous &&
      (assertionHash(previous) !== assertionHash(content) ||
        previous.kind !== content.kind ||
        previous.valid_from !== content.valid_from ||
        previous.valid_until !== content.valid_until)
    )
      yield* suppress(employeeId, projectId, previous, 'retracted')
    if (change.action === 'supersede') {
      const old = previous!
      const nextId = randomUUID()
      yield* sql`INSERT INTO project_memory_items(id,employee_id,project_id,title,current_revision,status) VALUES(${nextId},${employeeId},${projectId},${content.title},1,'active')`
      yield* writeRevision(nextId, 1, content, 'active', evidence, 'supersede', plan.basis)
      yield* writeRevision(
        old.id,
        old.revision + 1,
        { ...normalized(old, old), valid_until: content.valid_from },
        old.status === 'retired' ? 'retired' : 'superseded',
        old.evidence,
        'supersede',
        old.basis,
      )
      yield* sql`UPDATE project_memory_items SET successor_id=${nextId} WHERE employee_id=${employeeId} AND project_id=${projectId} AND id=${old.id}`
      id = nextId
      revision = 1
    } else {
      if (!previous)
        yield* sql`INSERT INTO project_memory_items(id,employee_id,project_id,title,current_revision,status) VALUES(${id},${employeeId},${projectId},${content.title},${revision},${status})`
      yield* writeRevision(id, revision, content, status, evidence, change.action, plan.revisionBasis)
    }
    if (change.action === 'retire' && previous?.status !== 'retired')
      yield* suppress(employeeId, projectId, yield* readProjectMemory(employeeId, projectId, id), 'retired')
    if (change.action === 'correct' && status === 'retired')
      yield* suppress(employeeId, projectId, yield* readProjectMemory(employeeId, projectId, id), 'retired')
    yield* projectMemoryDocument(employeeId, projectId, id)
    if (change.action === 'supersede' && previous) yield* projectMemoryDocument(employeeId, projectId, previous.id)
    yield* queueEmbeddings(employeeId, projectId, id)
    if (change.action === 'supersede' && previous) yield* queueEmbeddings(employeeId, projectId, previous.id)
    yield* sql`UPDATE project_memory_state SET knowledge_epoch=knowledge_epoch+1,search_generation=search_generation+1,core_epoch=core_epoch+${previous?.core || content.core ? 1 : 0} WHERE employee_id=${employeeId} AND project_id=${projectId}`
  }
  const result = yield* readProjectMemory(employeeId, projectId, id)
  yield* sql`INSERT INTO project_memory_changes(employee_id,project_id,operation_id,request_hash,action,item_id,before_item_id,before_revision,after_revision,result) VALUES(${employeeId},${projectId},${change.operation_id},${plan.requestHash},${change.action},${id},${previous?.id ?? null},${previous?.revision ?? 0},${result.revision},${JSON.stringify(result)}::jsonb)`
  if (plan.changed && actor.type === 'employee')
    yield* insertProjectInput(employeeId, plan.agentId, 'memory_updated', `memory:${id}:rev:${result.revision}`, {
      entry_id: id,
      title: result.title,
      revision: result.revision,
      author: 'user',
      status: result.status,
    })
  return result
})

// 调用方在事务内使用；与工具回执、业务登记保持同一次提交。
export const applyChange = Effect.fn('applyMemoryChange')(function* (
  employeeId: string,
  projectId: string,
  actor: MemoryActor,
  change: MemoryChange,
) {
  return yield* executeChange(yield* planChange(employeeId, projectId, actor, change))
})
export const writeProjectMemory = (
  employeeId: string,
  projectId: string,
  itemId: string | undefined,
  input: P.WriteMemoryInput,
) =>
  transaction(
    applyChange(
      employeeId,
      projectId,
      { type: 'employee' },
      {
        operation_id: input.operation_id,
        item_id: itemId,
        expected_revision: input.expected_revision,
        action: input.expected_revision === 0 ? 'add' : 'correct',
        content: input,
      },
    ),
  )
export const changeProjectMemory = (
  employeeId: string,
  projectId: string,
  itemId: string,
  input: P.ChangeMemoryInput,
) =>
  transaction(
    applyChange(employeeId, projectId, { type: 'employee' }, { ...input, item_id: itemId, content: input.successor }),
  )
