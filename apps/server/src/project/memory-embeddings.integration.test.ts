import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { withTestDatabase } from '../testing/database.ts'
import { projectToolFixture } from '../testing/project-tools.ts'
import { transaction } from '../database.ts'
import { patchProject, getProject } from './projects.ts'
import { runtimeRequest } from './runtime.ts'
import {
  commitEmbedding,
  changeProjectMemory,
  embeddingText,
  hashText,
  recall,
  writeProjectMemory,
  pendingEmbeddings,
  deferEmbedding,
  embeddingStatus,
} from './memory/index.ts'

// 固定向量只指定流程中的排序事实，不代表模型对自然语言的真实语义质量。
it('stores optional public configuration, queues revisions, commits bound vectors and rejects stale results', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    expect((await db.run(getProject(c.employeeId, c.projectId))).memory_embedding).toBeNull()
    const item = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: 'archive',
        content: '保留可追溯的构建产物。',
      }),
    )
    const setting = { base_url: 'http://127.0.0.1:4321/v1', model: 'custom-model-any-id' }
    const project = await db.run(patchProject(c.employeeId, c.projectId, { memory_embedding: setting }))
    const config = project.memory_embedding!
    expect(config).toMatchObject(setting)
    expect(
      (
        await db.run(
          patchProject(c.employeeId, c.projectId, {
            memory_embedding: { ...setting, base_url: setting.base_url + '/' },
          }),
        )
      ).memory_embedding!.config_id,
    ).toBe(config.config_id)
    const pending = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          state: string
          embedding_text_hash: string
        }>`SELECT state,embedding_text_hash FROM project_memory_embeddings WHERE project_id=${c.projectId}`
      }),
    )
    expect(pending).toEqual([{ state: 'pending', embedding_text_hash: hashText(embeddingText(item)) }])
    const input = {
      item_id: item.id,
      revision: item.revision,
      config_id: config.config_id,
      embedding_text_hash: pending[0]!.embedding_text_hash,
      vector: [1, 0, 0],
    }
    expect(await db.run(transaction(commitEmbedding(c.employeeId, c.projectId, input)))).toEqual({ accepted: true })
    expect(
      await db.run(transaction(commitEmbedding(c.employeeId, c.projectId, { ...input, embedding_text_hash: 'wrong' }))),
    ).toEqual({ accepted: false })
    const edited = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, item.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        title: item.title,
        content: '只保留已验证产物。',
      }),
    )
    expect(await db.run(transaction(commitEmbedding(c.employeeId, c.projectId, input)))).toEqual({ accepted: false })
    const revised = { ...input, revision: edited.revision, embedding_text_hash: hashText(embeddingText(edited)) }
    expect(await db.run(transaction(commitEmbedding(c.employeeId, c.projectId, revised)))).toEqual({ accepted: true })
    const changed = await db.run(
      patchProject(c.employeeId, c.projectId, {
        memory_embedding: { ...setting, model: 'other-model', credential_profile: 'local-profile' },
      }),
    )
    const work = await db.run(pendingEmbeddings(c.employeeId, c.projectId))
    expect(work.entries).toHaveLength(1)
    await db.run(transaction(deferEmbedding(c.employeeId, c.projectId, work.entries[0]!, 'embedding_timeout')))
    expect((await db.run(pendingEmbeddings(c.employeeId, c.projectId))).entries).toEqual([])
    expect(await db.run(embeddingStatus(c.employeeId, c.projectId, changed.memory_embedding!.config_id))).toMatchObject(
      { pending: 1, diagnostic: 'embedding_timeout' },
    )
    const [effects] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          failure_count: number
          attention: number
        }>`SELECT failure_count,(SELECT count(*)::float8 FROM attention_requests WHERE project_id=${c.projectId}) AS attention FROM conversations WHERE id=${c.conversationId}`
      }),
    )
    expect(effects).toEqual({ failure_count: 0, attention: 0 })
    expect(changed.memory_embedding!.config_id).not.toBe(config.config_id)
    expect(await db.run(transaction(commitEmbedding(c.employeeId, c.projectId, revised)))).toEqual({ accepted: false })
    await db.run(
      changeProjectMemory(c.employeeId, c.projectId, item.id, {
        operation_id: randomUUID(),
        expected_revision: edited.revision,
        action: 'retire',
      }),
    )
    expect(
      await db.run(
        transaction(
          commitEmbedding(c.employeeId, c.projectId, { ...revised, config_id: changed.memory_embedding!.config_id }),
        ),
      ),
    ).toEqual({ accepted: false })
    expect(
      (await db.run(patchProject(c.employeeId, c.projectId, { memory_embedding: null }))).memory_embedding,
    ).toBeNull()
    expect(
      Schema.is(P.PatchProjectInput)({ memory_embedding: { ...setting, base_url: 'http://name:secret@localhost/v1' } }),
    ).toBe(false)
    expect(Schema.is(P.PatchProjectInput)({ memory_embedding: { ...setting, base_url: 'file:///tmp/model' } })).toBe(
      false,
    )
    expect(Schema.is(P.MemoryEmbeddingConfigInput)({ ...setting, credential_profile: '../secret' })).toBe(false)
    expect(Schema.is(P.MemoryEmbeddingConfigInput)({ ...setting, credential_profile: 'local_Profile' })).toBe(false)
    expect(Schema.is(P.EmbeddingVector)([0, 0])).toBe(false)
    expect(Schema.is(P.EmbeddingVector)([NaN, 1])).toBe(false)
  }))

it('uses explicit tool query vectors without changing saved arguments and selects historical factual intervals', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      db.run(
        runtimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation,
          ...extra,
        }),
      )
    const config = (
      await db.run(
        patchProject(c.employeeId, c.projectId, {
          memory_embedding: { base_url: 'http://localhost:4321/v1', model: 'local' },
        }),
      )
    ).memory_embedding!
    const original = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '存储决定',
        content: '使用数据库 A。',
        semantic_key: 'storage',
        valid_from: '2000-01-01T00:00:00Z',
      }),
    )
    await db.run(
      transaction(
        commitEmbedding(c.employeeId, c.projectId, {
          item_id: original.id,
          revision: 1,
          config_id: config.config_id,
          embedding_text_hash: hashText(embeddingText(original)),
          vector: [1, 0],
        }),
      ),
    )
    const successor = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, original.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'supersede',
        successor: {
          title: '存储决定',
          content: '使用数据库 B。',
          semantic_key: 'storage',
          valid_from: '2001-01-01T00:00:00Z',
        },
      }),
    )
    await db.run(
      transaction(
        commitEmbedding(c.employeeId, c.projectId, {
          item_id: successor.id,
          revision: 1,
          config_id: config.config_id,
          embedding_text_hash: hashText(embeddingText(successor)),
          vector: [0, 1],
        }),
      ),
    )
    const args = { query: 'old storage choice', mode: 'history', as_of: '2000-06-01T00:00:00Z' }
    const context = Schema.decodeUnknownSync(P.MemoryContext)(
      await rpc('prepare_context', {
        last_seq: 1,
        payload: { context_id: randomUUID(), input_seq: 0, ...P.MEMORY_CONTEXT_DEFAULTS },
      }),
    )
    await rpc('append_event', {
      last_seq: 1,
      client_event_id: 'recall',
      payload: {
        format: 'pi-ai/1',
        memory_context_id: context.context_id,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'recall-call', name: 'memory.recall', arguments: args }],
        },
      },
    })
    const query = Schema.decodeUnknownSync(P.MemoryEmbeddingQuery)(
      await rpc('embedding_query', { last_seq: 2, payload: { input_seq: 0, query: args.query } }),
    )
    expect(query.query).toBe(args.query)
    const extra = {
      last_seq: 2,
      tool_call_id: 'recall-call',
      tool_name: 'memory.recall',
      arguments: args,
      payload: { query_vector: { config_id: config.config_id, query_hash: query.query_hash, vector: [1, 0] } },
    }
    const saved = Schema.decodeUnknownSync(P.ProjectEvent)(await rpc('call_tool', extra))
    const body = Schema.decodeUnknownSync(
      Schema.Struct({ message: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }) }),
    )(saved.payload)
    const results = Schema.decodeUnknownSync(Schema.fromJsonString(P.MemoryRecallResult))(body.message.content[0]!.text)
    expect(results.entries.filter((hit) => hit.item).map((hit) => hit.item!.id)).toEqual([original.id])
    expect(results.memory_refs).toContainEqual({
      item_id: original.id,
      revision: 2,
      mode: 'history',
      as_of: args.as_of,
    })
    expect(await rpc('call_tool', { ...extra, payload: { query_vector: 'invalid retry payload' } })).toEqual(saved)
    const [assistant] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          arguments: unknown
        }>`SELECT payload->'message'->'content'->0->'arguments' AS arguments FROM conversation_events WHERE conversation_id=${c.conversationId} AND seq=2`
      }),
    )
    expect(assistant!.arguments).toEqual(args)
  }))

it('keeps a unique long lexical hit in automatic context without Embedding', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const item = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: 'Long',
        content: '完整技术记录。'.repeat(2000) + ' longNeedle',
      }),
    )
    await db.run(patchProject(c.employeeId, c.projectId, { goal: 'longNeedle' }))
    const snapshot = Schema.decodeUnknownSync(P.MemoryContext)(
      await db.run(
        runtimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation: 'prepare_context',
          last_seq: 1,
          payload: { context_id: randomUUID(), input_seq: 0, ...P.MEMORY_CONTEXT_DEFAULTS },
        }),
      ),
    )
    expect(snapshot.content).toContain('longNeedle')
    expect(snapshot.content).toContain('memory.read(item_id=' + item.id)
    expect(snapshot.degraded).toContain('related_snippet_truncated')
    expect(snapshot.content).not.toContain(item.content)
  }))

it('fuses independent pgvector hits, preserves a unique long automatic snippet and validates query/config bindings', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      db.run(
        runtimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation,
          ...extra,
        }),
      )
    const item = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '产物留存',
        content: '保留构建产物，便于回查。' + '历史细节。'.repeat(1800),
      }),
    )
    const core = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '核心条件',
        content: '不要跳过验证；只有文档可例外。',
        core: true,
      }),
    )
    const project = await db.run(
      patchProject(c.employeeId, c.projectId, {
        goal: 'cleanup stale artifacts',
        memory_embedding: { base_url: 'http://localhost:4321/v1', model: 'local' },
      }),
    )
    const configuration = project.memory_embedding!
    await db.run(
      transaction(
        commitEmbedding(c.employeeId, c.projectId, {
          item_id: item.id,
          revision: item.revision,
          config_id: configuration.config_id,
          embedding_text_hash: hashText(embeddingText(item)),
          vector: [1, 0],
        }),
      ),
    )
    const query = Schema.decodeUnknownSync(P.MemoryEmbeddingQuery)(
      await rpc('embedding_query', { last_seq: 1, payload: { input_seq: 0 } }),
    )
    expect(query.query).toContain('cleanup stale artifacts')
    expect(query.query).not.toContain(c.projectId)
    const vector = { config_id: configuration.config_id, query_hash: query.query_hash, vector: [1, 0] }
    const lexical = await db.run(transaction(recall(c.employeeId, c.projectId, { query: query.query }, true)))
    expect(lexical.entries).toEqual([])
    expect(lexical.degraded).toContain('embedding_query_missing')
    const mixed = await db.run(
      transaction(recall(c.employeeId, c.projectId, { query: query.query }, true, undefined, vector)),
    )
    expect(mixed.entries[0]!.item!.id).toBe(item.id)
    expect(mixed.entries[0]!.item!.evidence).toHaveLength(1)
    const prepare = async (query_vector: typeof vector | undefined) =>
      Schema.decodeUnknownSync(P.MemoryContext)(
        await rpc('prepare_context', {
          last_seq: 1,
          payload: {
            context_id: randomUUID(),
            input_seq: 0,
            ...P.MEMORY_CONTEXT_DEFAULTS,
            ...(query_vector ? { query_vector } : {}),
          },
        }),
      )
    const automatic = await prepare(vector)
    expect(automatic.content).toContain('保留构建产物')
    expect(automatic.content).toContain('片段已截断')
    expect(automatic.content).toContain('memory.read(item_id=' + item.id)
    expect(automatic.content).toContain(core.content)
    expect(automatic.memory_refs.map((ref) => ('item_id' in ref ? ref.item_id : undefined))).toContain(item.id)
    expect(automatic.degraded).toContain('related_snippet_truncated')
    expect((await prepare({ ...vector, query_hash: 'wrong' })).degraded).toContain('embedding_query_changed')
    expect((await prepare({ ...vector, vector: [1, 0, 0] })).degraded).toContain('embedding_dimension_mismatch')
    await db.run(
      changeProjectMemory(c.employeeId, c.projectId, item.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'retire',
      }),
    )
    expect((await prepare(vector)).content).not.toContain('保留构建产物')
    await db.run(
      patchProject(c.employeeId, c.projectId, {
        memory_embedding: { base_url: 'http://localhost:4321/v1', model: 'changed' },
      }),
    )
    expect((await prepare(vector)).degraded).toContain('embedding_query_changed')
    await db.run(patchProject(c.employeeId, c.projectId, { memory_embedding: null }))
    const disabled = Schema.decodeUnknownSync(P.MemoryEmbeddingQuery)(
      await rpc('embedding_query', { last_seq: 1, payload: { input_seq: 0 } }),
    )
    expect(disabled.memory_embedding).toBeNull()
  }))
