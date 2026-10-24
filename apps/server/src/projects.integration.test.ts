import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { seedNode, withTestDatabase, type TestDatabase } from './testing/database.ts'
import * as projects from './projects.ts'
import { insertProjectInput } from './project-inputs.ts'
import * as threads from './threads.ts'

type Run = TestDatabase['run']
const projectRuntimeReport: P.RuntimeReport = {
  project_runtime: { version: '0.1.0', providers: [{ provider: 'openai-codex', status: 'available' }] },
  roots: [{ root_id: 'dev', path: '/workspace' }],
  repos: [],
  exec: { enabled: true, shell: '/bin/sh' },
}
async function fixture(run: Run) {
  const {
    employeeId: employee,
    nodeId: node,
    credentialId: credential,
    source,
  } = await seedNode(run, {
    report: projectRuntimeReport,
  })
  const input = { title: 'Project', goal: 'Goal', provider: 'openai-codex', model: 'gpt-5' }
  const create = () => run(projects.createProject(employee, input))
  const start = async (p: P.Project) => {
    await run(projects.acceptProjectMessage(employee, p.id, { client_message_id: randomUUID(), content: 'hello' }))
    await Promise.all([run(projects.scheduleProjectRun(p.agent.id)), run(projects.scheduleProjectRun(p.agent.id))])
    const deliveries = await run(projects.claimProjectCommands('project_run_start', () => 0.5))
    const delivery = deliveries.find((d) => d.command.project_id === p.id)!
    expect(delivery).toBeDefined()
    expect(deliveries.filter((d) => d.command.project_id === p.id)).toHaveLength(1)
    const identity = { run_id: delivery.command.run_id, lease_epoch: delivery.command.lease_epoch }
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      run(projects.runtimeRequest(source, { type: 'project_runtime.request', ...identity, operation, ...extra }))
    await rpc('started')
    return { rpc, identity, delivery }
  }
  return { employee, node, credential, source, input, create, start }
}
const assistant = (content: Schema.Json[] = [{ type: 'text', text: 'done' }]) => ({
  format: 'pi-ai/1',
  message: {
    role: 'assistant',
    content,
    provider: 'openai-codex',
    model: 'gpt-5',
    timestamp: 1,
    usage: { input: 1, output: 1, totalTokens: 2 },
    stopReason: 'stop',
  },
})
const result = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

describe('Project creation and messages', () => {
  it(
    'keeps Project identities and the original creation request across edits',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          id = randomUUID(),
          p = await run(projects.createProject(a.employee, { ...a.input, client_project_id: id }))
        await run(projects.patchProject(a.employee, p.id, { title: 'Renamed', goal: 'new goal' }))
        const repeated = await run(projects.createProject(a.employee, { ...a.input, client_project_id: id }))
        expect(repeated.id).toBe(p.id)
        expect(repeated.title).toBe('Renamed')
        expect(repeated.agent.id).toBe(p.agent.id)
        await expect(
          run(projects.createProject(a.employee, { ...a.input, title: 'different', client_project_id: id })),
        ).rejects.toMatchObject({ code: 'project_conflict' })
      }),
    30_000,
  )

  it(
    'isolates Project reads and lists by employee',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create()
        const b = await fixture(run)
        await expect(run(projects.getProject(b.employee, p.id))).rejects.toMatchObject({ code: 'not_found' })
        expect((await run(projects.listProjects(a.employee, '', 1))).projects).toHaveLength(1)
        expect((await run(projects.listProjects(b.employee))).projects).toEqual([])
      }),
    30_000,
  )

  it(
    'persists Project messages once and rejects conflicting retries',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create()
        const m = { client_message_id: 'message-1', content: 'offline input' }
        const saved = await run(projects.acceptProjectMessage(a.employee, p.id, m))
        expect(await run(projects.acceptProjectMessage(a.employee, p.id, m))).toEqual(saved)
        await expect(
          run(projects.acceptProjectMessage(a.employee, p.id, { ...m, content: 'different' })),
        ).rejects.toMatchObject({ code: 'message_conflict' })
        expect((await run(projects.projectMessages(a.employee, p.id))).messages).toEqual([saved])
      }),
    30_000,
  )

  it(
    'rejects Project input that exceeds the encoded frame budget',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create()
        await expect(
          run(
            projects.acceptProjectMessage(a.employee, p.id, {
              client_message_id: 'escaped',
              content: '\u0001'.repeat(14000),
            }),
          ),
        ).rejects.toMatchObject({ code: 'too_large' })
      }),
    30_000,
  )
})

describe('runtime leases and persisted requests', () => {
  it(
    'places one run under concurrent scheduling and snapshots its configuration',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        expect(r.delivery.employee_id).toBe(a.employee)
        const boot = result(P.ProjectBootstrap, await r.rpc('bootstrap'))
        expect(boot.project.agent.model).toBe('gpt-5')
        await run(projects.patchProject(a.employee, p.id, { model: 'next-model' }))
        expect(result(P.ProjectBootstrap, await r.rpc('bootstrap')).project.agent.model).toBe('gpt-5')
      }),
    30_000,
  )

  it(
    'acknowledges wake delivery separately from claiming Project input',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        const wakes = await run(projects.claimProjectCommands('project_run_wake', () => 0.5))
        expect(wakes).toHaveLength(1)
        const ids = wakes[0]!.command.input_ids!
        await r.rpc('wake_received', { payload: { input_ids: ids } })
        expect(await run(projects.claimProjectCommands('project_run_wake'))).toEqual([])
        expect((await run(projects.projectStatus(a.employee, p.id))).pending_inputs).toBe(1)
        const claim = result(P.ProjectClaim, await r.rpc('claim_inputs', { last_seq: 0 }))
        expect(claim.input_count).toBe(1)
        expect(claim.event?.seq).toBe(1)
        expect((await run(projects.projectMessages(a.employee, p.id))).messages).toEqual([])
      }),
    30_000,
  )

  it(
    'rejects runtime requests from replaced node connections',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        await expect(
          run(
            projects.runtimeRequest(
              { ...a.source, conn_id: 'old' },
              { type: 'project_runtime.request', ...r.identity, operation: 'renew' },
            ),
          ),
        ).rejects.toMatchObject({ code: 'lease_lost' })
      }),
    30_000,
  )

  it(
    'persists Project events once and rejects conflicting retries',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        await r.rpc('claim_inputs')
        const eventId = randomUUID(),
          payload = assistant()
        const event = result(
          P.ProjectEvent,
          await r.rpc('append_event', { last_seq: 1, client_event_id: eventId, payload }),
        )
        expect(
          result(P.ProjectEvent, await r.rpc('append_event', { last_seq: 1, client_event_id: eventId, payload })),
        ).toEqual(event)
        await expect(
          r.rpc('append_event', {
            last_seq: 2,
            client_event_id: eventId,
            payload: assistant([{ type: 'text', text: 'different' }]),
          }),
        ).rejects.toMatchObject({ code: 'conflict' })
      }),
    30_000,
  )

  it(
    'fences stopped runs and accepts repeated cleanup receipts',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        await r.rpc('claim_inputs')
        const payload = assistant()
        await r.rpc('append_event', { last_seq: 1, client_event_id: randomUUID(), payload })
        await run(projects.stopProject(a.employee, p.id))
        await expect(
          r.rpc('append_event', { last_seq: 2, client_event_id: randomUUID(), payload }),
        ).rejects.toMatchObject({ code: 'lease_lost' })
        const stops = await run(projects.claimProjectCommands('project_run_stop'))
        expect(stops).toHaveLength(1)
        await r.rpc('stopped')
        await r.rpc('stopped')
        expect((await run(projects.projectStatus(a.employee, p.id))).run).toMatchObject({
          state: 'finished',
          end_reason: 'user_stopped',
        })
      }),
    30_000,
  )

  it(
    'executes saved tools in order exactly once, including after a replacement run',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        await r.rpc('claim_inputs')
        const calls = [
          {
            type: 'toolCall',
            id: 'write-1',
            name: 'memory.write',
            arguments: { title: 'Decision', content: 'Use SQL', expected_revision: 0 },
          },
          { type: 'toolCall', id: 'read-1', name: 'memory.search', arguments: { query: 'Decision' } },
        ]
        await r.rpc('append_event', { last_seq: 1, client_event_id: 'assistant-1', payload: assistant(calls) })
        await expect(
          r.rpc('call_tool', {
            last_seq: 2,
            tool_call_id: 'read-1',
            tool_name: 'memory.search',
            arguments: { query: 'Decision' },
          }),
        ).rejects.toMatchObject({ code: 'conflict' })
        await expect(
          r.rpc('call_tool', {
            last_seq: 2,
            tool_call_id: 'write-1',
            tool_name: 'memory.write',
            arguments: { title: 'tampered' },
          }),
        ).rejects.toMatchObject({ code: 'invalid' })
        const request = {
          last_seq: 2,
          tool_call_id: 'write-1',
          tool_name: 'memory.write',
          arguments: calls[0]!.arguments,
        }
        const event = result(P.ProjectEvent, await r.rpc('call_tool', request))
        expect(await r.rpc('call_tool', request)).toEqual(event)
        await expect(
          r.rpc('append_event', { last_seq: 3, client_event_id: 'premature', payload: assistant() }),
        ).rejects.toMatchObject({ code: 'conflict' })
        await r.rpc('call_tool', {
          last_seq: 3,
          tool_call_id: 'read-1',
          tool_name: 'memory.search',
          arguments: { query: 'Decision' },
        })
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${p.agent.id}`
          }),
        )
        await run(projects.scheduleProjectRun(p.agent.id))
        const [replacement] = await run(projects.claimProjectCommands('project_run_start'))
        expect(replacement!.command.lease_epoch).toBe(r.identity.lease_epoch + 1)
        await expect(r.rpc('renew')).rejects.toMatchObject({ code: 'lease_lost' })
        const retry = await run(
          projects.runtimeRequest(a.source, {
            type: 'project_runtime.request',
            run_id: replacement!.command.run_id,
            lease_epoch: replacement!.command.lease_epoch,
            operation: 'call_tool',
            ...request,
          }),
        )
        expect(retry).toEqual(event)
        const [count] = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              n: string
            }>`SELECT count(*) AS n FROM project_memory_revisions WHERE employee_id=${a.employee}`
          }),
        )
        expect(Number(count!.n)).toBe(1)
      }),
    30_000,
  )
})

describe('input notification and batching', () => {
  it(
    'folds older memory notifications without starting a run before user input',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create()
        await run(
          Effect.gen(function* () {
            for (let i = 1; i <= 30; i++)
              yield* insertProjectInput(a.employee, p.agent.id, 'memory_updated', `memory:m:rev:${i}`, {
                entry_id: 'm',
                revision: i,
                title: 'Title',
              })
          }),
        )
        await run(projects.scheduleProjectRun(p.agent.id))
        expect(await run(projects.claimProjectCommands('project_run_start'))).toEqual([])
        const r = await a.start(p)
        const claimed = result(P.ProjectClaim, await r.rpc('claim_inputs', { last_seq: 0 }))
        const payload = result(
          Schema.Struct({
            input_ids: Schema.Array(Schema.Number),
            message: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
          }),
          claimed.event!.payload,
        )
        const items = JSON.parse(payload.message.content[0]!.text)
        expect(items[0].payload.revision).toBe(30)
        const [old] = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              n: string
            }>`SELECT count(*) AS n FROM project_agent_input_queue WHERE agent_id=${p.agent.id} AND source_type='memory_updated' AND delivered_seq IS NULL`
          }),
        )
        expect(Number(old!.n)).toBe(0)
      }),
    30_000,
  )

  it(
    'claims bounded ordered batches of Project input',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create()
        const r = await a.start(p)
        await run(
          Effect.gen(function* () {
            for (let i = 0; i < 23; i++)
              yield* insertProjectInput(a.employee, p.agent.id, 'thread_reply', `reply:${i}`, {
                content: 'x'.repeat(30 * 1024),
                thread_id: randomUUID(),
              })
          }),
        )
        let seq = 0,
          total = 0
        while (true) {
          const claimed = result(P.ProjectClaim, await r.rpc('claim_inputs', { last_seq: seq }))
          if (!claimed.event) break
          expect(claimed.input_count).toBeLessThanOrEqual(20)
          expect(claimed.payload_bytes).toBeLessThanOrEqual(128 * 1024)
          total += claimed.input_count
          seq = claimed.event.seq
          await r.rpc('append_event', { last_seq: seq, client_event_id: randomUUID(), payload: assistant() })
          seq++
          await run(
            projects.acceptProjectMessage(a.employee, p.id, { client_message_id: randomUUID(), content: 'continue' }),
          )
          const status = await run(projects.projectStatus(a.employee, p.id))
          if (status.pending_inputs === 1) break
        }
        expect(total).toBeGreaterThan(23)
      }),
    30_000,
  )
})

describe('failure recovery and suspension', () => {
  it(
    'persists failure backoff, creates one system request, retries and archives open requests',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create()
        for (let i = 0; i < 3; i++) {
          const r = await a.start(p)
          await r.rpc('report_failure', { reason: 'model failed' })
          const status = await run(projects.projectStatus(a.employee, p.id))
          expect(status.state).toBe(i === 2 ? 'needs_attention' : 'waiting')
          expect(status.last_error).toBe('model failed')
          await run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`UPDATE conversations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${p.conversation.id}`
            }),
          )
        }
        const [count] = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              n: string
            }>`SELECT count(*) AS n FROM attention_requests WHERE project_id=${p.id} AND source='system' AND state='open'`
          }),
        )
        expect(Number(count!.n)).toBe(1)
        await run(projects.retryProject(a.employee, p.id))
        expect((await run(projects.getProject(a.employee, p.id))).conversation.state).toBe('active')
        await a.start(p)
        await run(projects.patchProject(a.employee, p.id, { status: 'archived' }))
        const [open] = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              n: string
            }>`SELECT count(*) AS n FROM attention_requests WHERE project_id=${p.id} AND state='open'`
          }),
        )
        expect(Number(open!.n)).toBe(0)
      }),
    30_000,
  )

  it(
    'pauses an active Project and fences its runtime lease',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        await run(projects.patchProject(a.employee, p.id, { status: 'paused' }))
        await expect(r.rpc('renew')).rejects.toMatchObject({ code: 'lease_lost' })
        expect((await run(projects.projectStatus(a.employee, p.id))).state).toBe('paused')
      }),
    30_000,
  )
})

describe('runtime frame budgets', () => {
  it(
    'encodes an oversized Project goal within the bootstrap frame budget',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await run(projects.createProject(a.employee, { ...a.input, goal: '\u0001'.repeat(40000) })),
          r = await a.start(p)
        const boot = result(P.ProjectBootstrap, await r.rpc('bootstrap'))
        expect(boot.project.goal).toBe('')
        expect(Buffer.from(boot.goal_utf8_base64!, 'base64').toString()).toBe('\u0001'.repeat(40000))
      }),
    30_000,
  )

  it(
    'paginates Project events within runtime and UI frame budgets',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        for (let i = 0; i < 9; i++)
          await r.rpc('append_event', {
            last_seq: i,
            client_event_id: `large-${i}`,
            payload: assistant([{ type: 'text', text: 'x'.repeat(130 * 1024) }]),
          })
        let after = 0,
          seen = 0
        while (after < 9) {
          const page = result(P.ProjectEventPage, await r.rpc('read_events', { after_seq: after }))
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(192 * 1024)
          seen += page.events!.length
          after = page.next_after_seq
        }
        expect(seen).toBe(9)
        const ui = await run(projects.projectEvents(a.employee, p.id, 0, 100))
        expect(ui.has_more).toBe(true)
      }),
    30_000,
  )
})

async function withRowLocks(
  run: Run,
  table: 'agent_runs' | 'project_agent_input_queue' | 'project_agents',
  ids: readonly (string | number)[],
  body: () => Promise<void>,
) {
  let unlock!: () => void, acquired!: () => void
  const release = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const ready = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const held = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (table !== 'project_agent_input_queue')
            yield* sql`SELECT id FROM ${sql(table)} WHERE id=ANY(${ids}::uuid[]) FOR UPDATE`
          else yield* sql`SELECT id FROM project_agent_input_queue WHERE id=ANY(${ids}::bigint[]) FOR UPDATE`
          acquired()
          yield* Effect.promise(() => release)
        }),
      )
    }),
  )
  try {
    await Promise.race([ready, held])
    await body()
  } finally {
    unlock()
    await held
  }
}

it(
  'keeps compaction atomic, protects tool pairs and resumes work behind the compaction event',
  async () =>
    withTestDatabase(async ({ run }) => {
      const a = await fixture(run),
        p = await a.create(),
        r = await a.start(p)
      await r.rpc('claim_inputs')
      await r.rpc('append_event', {
        last_seq: 1,
        client_event_id: 'tools',
        payload: assistant([{ type: 'toolCall', id: 'list', name: 'devices.list', arguments: {} }]),
      })
      await r.rpc('call_tool', { last_seq: 2, tool_call_id: 'list', tool_name: 'devices.list', arguments: {} })
      await run(projects.acceptProjectMessage(a.employee, p.id, { client_message_id: 'next', content: 'continue' }))
      await r.rpc('claim_inputs', { last_seq: 3 })
      const payload = {
        through_seq: 3,
        summary: '已读取设备。',
        cleared_tool_result_seqs: [],
        memory_index: '',
        prompt: { version: '1', title: p.title, goal: p.goal },
        tokens_before: 1000,
        tokens_after: 100,
        provider: 'openai-codex',
        model: 'gpt-5',
      }
      await expect(
        r.rpc('commit_compaction', { last_seq: 4, client_event_id: 'bad', payload: { ...payload, through_seq: 2 } }),
      ).rejects.toMatchObject({ code: 'invalid' })
      await expect(
        r.rpc('commit_compaction', {
          last_seq: 4,
          client_event_id: 'bad',
          payload: { ...payload, prompt: { ...payload.prompt, title: 'stale' } },
        }),
      ).rejects.toMatchObject({ code: 'conflict' })
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE FUNCTION reject_compaction_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected pointer failure'; END $$`
          yield* sql`CREATE TRIGGER reject_compaction_pointer BEFORE UPDATE ON conversations FOR EACH ROW WHEN (NEW.compaction_seq IS DISTINCT FROM OLD.compaction_seq) EXECUTE FUNCTION reject_compaction_pointer()`
        }),
      )
      await expect(
        r.rpc('commit_compaction', { last_seq: 4, client_event_id: 'rollback', payload }),
      ).rejects.toMatchObject({ code: 'unavailable' })
      expect((await run(projects.getProject(a.employee, p.id))).conversation.last_seq).toBe(4)
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP TRIGGER reject_compaction_pointer ON conversations`
        }),
      )
      const commits = await Promise.allSettled(
        ['a', 'b'].map((client_event_id) => r.rpc('commit_compaction', { last_seq: 4, client_event_id, payload })),
      )
      expect(commits.filter((v) => v.status === 'fulfilled')).toHaveLength(1)
      expect(commits.filter((v) => v.status === 'rejected')).toHaveLength(1)
      await r.rpc('exited', { reason: 'process exited' })
      await run(projects.scheduleProjectRun(p.agent.id))
      const [replacement] = await run(projects.claimProjectCommands('project_run_start'))
      const boot = result(
        P.ProjectBootstrap,
        await run(
          projects.runtimeRequest(a.source, {
            type: 'project_runtime.request',
            run_id: replacement!.command.run_id,
            lease_epoch: replacement!.command.lease_epoch,
            operation: 'bootstrap',
          }),
        ),
      )
      expect(boot.after_seq).toBe(3)
      expect(boot.compaction?.seq).toBe(5)
      expect((await run(projects.projectEvents(a.employee, p.id))).events).toHaveLength(5)
    }),
  30_000,
)

async function scheduleRuns(run: Run, a: Awaited<ReturnType<typeof fixture>>) {
  const runs: string[] = []
  for (let i = 0; i < 3; i++) {
    const p = await a.create()
    await run(projects.acceptProjectMessage(a.employee, p.id, { client_message_id: randomUUID(), content: 'start' }))
    await run(projects.scheduleProjectRun(p.agent.id))
    const row = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ id: string }>`SELECT id FROM agent_runs WHERE agent_id=${p.agent.id}`
      }),
    )
    runs.push(row[0]!.id)
  }
  return runs
}

describe('command claims and quotas', () => {
  it(
    'skips locked run heads and later claims the unlocked runs',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run)
        const runs = await scheduleRuns(run, a)
        await withRowLocks(run, 'agent_runs', runs.slice(0, 2), async () => {
          const commands = await run(projects.claimProjectCommands('project_run_start'))
          expect(commands.map((c) => c.command.run_id)).toEqual([runs[2]])
        })
        expect(await run(projects.claimProjectCommands('project_run_start'))).toHaveLength(2)
      }),
    30_000,
  )

  it(
    'keeps stop commands separate from start and wake quotas',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run)
        const runs = await scheduleRuns(run, a)
        const b = await fixture(run)
        expect(await run(projects.claimProjectCommands('project_run_start'))).toHaveLength(2)
        expect(await run(projects.claimProjectCommands('project_run_start'))).toHaveLength(1)
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE agent_runs SET state='finished',ended_at=clock_timestamp(),stop_requested_at=clock_timestamp(),command_next_at=clock_timestamp(),command_attempts=0 WHERE id=ANY(${runs.slice(0, 2)}::uuid[])`
            yield* sql`UPDATE project_agents SET lease_run_id=NULL,lease_until=NULL WHERE lease_run_id=ANY(${runs.slice(0, 2)}::uuid[])`
            yield* sql`UPDATE agent_runs SET state='running' WHERE id=${runs[2]}`
          }),
        )
        const pb = await b.create()
        await run(projects.acceptProjectMessage(b.employee, pb.id, { client_message_id: 'start-b', content: 'start' }))
        await run(projects.scheduleProjectRun(pb.agent.id))
        const starts = await run(projects.claimProjectCommands('project_run_start'))
        expect(starts).toHaveLength(1)
        expect(starts[0]!.node_id).toBe(b.node)
        expect(await run(projects.claimProjectCommands('project_run_stop'))).toHaveLength(2)
        expect(await run(projects.claimProjectCommands('project_run_wake'))).toHaveLength(1)
        expect(await run(projects.claimProjectCommands('project_run_stop'))).toEqual([])
      }),
    30_000,
  )
})

describe('lease validation after lock waits', () => {
  it(
    'rolls back claimed input and event when the lease expires while waiting for an input lock',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        const message = (await run(projects.projectMessages(a.employee, p.id))).messages![0]!
        let request: Promise<unknown> | undefined
        await withRowLocks(run, 'project_agent_input_queue', [message.id], async () => {
          await run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`UPDATE project_agents SET lease_until=clock_timestamp()+interval '0.2 seconds' WHERE id=${p.agent.id}`
            }),
          )
          request = r.rpc('claim_inputs')
          void request.catch(() => undefined)
          await run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`SELECT pg_sleep(0.3)`
            }),
          )
        })
        await expect(request).rejects.toMatchObject({ code: 'lease_lost' })
        expect((await run(projects.projectEvents(a.employee, p.id))).events).toEqual([])
        expect((await run(projects.projectMessages(a.employee, p.id))).messages).toHaveLength(1)
        expect((await run(projects.getProject(a.employee, p.id))).conversation.last_seq).toBe(0)
      }),
    30_000,
  )

  it(
    'rejects a historical cleanup receipt when its credential expires during the run lock wait',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run),
          p = await a.create(),
          r = await a.start(p)
        await run(projects.stopProject(a.employee, p.id))
        let receipt: Promise<unknown> | undefined
        await withRowLocks(run, 'agent_runs', [r.identity.run_id], async () => {
          await run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`UPDATE node_credentials SET expires_at=clock_timestamp()+interval '0.2 seconds' WHERE id=${a.credential}`
            }),
          )
          receipt = r.rpc('stopped')
          void receipt.catch(() => undefined)
          await run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`SELECT pg_sleep(0.3)`
            }),
          )
        })
        await expect(receipt).rejects.toMatchObject({ code: 'lease_lost' })
        expect((await run(projects.projectStatus(a.employee, p.id))).run?.stop_acked_at).toBeUndefined()
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE node_credentials SET expires_at=clock_timestamp()+interval '1 day' WHERE id=${a.credential}`
          }),
        )
        await r.rpc('stopped')
        expect((await run(projects.projectStatus(a.employee, p.id))).run).toMatchObject({
          state: 'finished',
          end_reason: 'user_stopped',
        })
      }),
    30_000,
  )
})

it(
  'protects recent tool results and retains the full cleared set across compactions',
  async () =>
    withTestDatabase(async ({ run }) => {
      const a = await fixture(run),
        p = await a.create(),
        r = await a.start(p)
      await r.rpc('claim_inputs')
      await r.rpc('append_event', {
        last_seq: 1,
        client_event_id: 'list',
        payload: assistant([{ type: 'toolCall', id: 'devices', name: 'devices.list', arguments: {} }]),
      })
      await r.rpc('call_tool', { last_seq: 2, tool_call_id: 'devices', tool_name: 'devices.list', arguments: {} })
      const payload = {
        through_seq: 0,
        summary: '',
        cleared_tool_result_seqs: [3],
        memory_index: '',
        prompt: { version: '1', title: p.title, goal: p.goal },
        tokens_before: 1000,
        tokens_after: 500,
        provider: 'openai-codex',
        model: 'gpt-5',
      }
      await expect(
        r.rpc('commit_compaction', { last_seq: 3, client_event_id: 'too-recent', payload }),
      ).rejects.toMatchObject({ code: 'invalid' })
      for (let i = 0; i < 3; i++) {
        await run(
          projects.acceptProjectMessage(a.employee, p.id, { client_message_id: `input-${i}`, content: 'continue' }),
        )
        await r.rpc('claim_inputs', { last_seq: 3 + i })
      }
      await r.rpc('append_event', { last_seq: 6, client_event_id: 'analysis', payload: assistant() })
      const event = await r.rpc('commit_compaction', { last_seq: 7, client_event_id: 'clear', payload })
      expect(await r.rpc('commit_compaction', { last_seq: 7, client_event_id: 'clear', payload })).toEqual(event)
      await expect(
        r.rpc('commit_compaction', {
          last_seq: 8,
          client_event_id: 'dropped-clear',
          payload: { ...payload, cleared_tool_result_seqs: [] },
        }),
      ).rejects.toMatchObject({ code: 'invalid' })
      expect((await run(projects.projectEvents(a.employee, p.id))).events).toHaveLength(8)
    }),
  30_000,
)

it(
  'stores a terminal exec result and consumes its input atomically through call_tool and wait_tool',
  async () =>
    withTestDatabase(async ({ run }) => {
      const a = await fixture(run),
        p = await a.create(),
        r = await a.start(p)
      await r.rpc('claim_inputs')
      const args = { node_id: a.node, command: 'printf done', working_directory: '/workspace', wait_seconds: 600 }
      await r.rpc('append_event', {
        last_seq: 1,
        client_event_id: 'exec',
        payload: assistant([{ type: 'toolCall', id: 'exec', name: 'nodes.exec', arguments: args }]),
      })
      const pending = result(
        Schema.Struct({ pending: Schema.Boolean, thread_id: Schema.String }),
        await r.rpc('call_tool', { last_seq: 2, tool_call_id: 'exec', tool_name: 'nodes.exec', arguments: args }),
      )
      expect(pending.pending).toBe(true)
      expect(await r.rpc('wait_tool', { last_seq: 2, tool_call_id: 'exec' })).toMatchObject({
        pending: true,
        thread_id: pending.thread_id,
      })
      await withRowLocks(run, 'project_agents', [p.agent.id], async () => {
        const value = await run(
          projects
            .runtimeRequest(a.source, {
              type: 'project_runtime.request',
              ...r.identity,
              operation: 'wait_tool',
              last_seq: 2,
              tool_call_id: 'exec',
            })
            .pipe(Effect.timeout('500 millis')),
        )
        expect(value).toMatchObject({ pending: true, thread_id: pending.thread_id })
      })
      expect((await run(projects.getProject(a.employee, p.id))).conversation.last_seq).toBe(2)
      const report = (
        seq: number,
        kind: P.ThreadReport['kind'],
        extra: Partial<P.ThreadReport> = {},
      ): P.ThreadReport => ({
        type: 'thread.report',
        thread_id: pending.thread_id,
        event_id: randomUUID(),
        worker_seq: seq,
        kind,
        storage_generation: 'generation',
        ...extra,
      })
      await run(threads.processReport(a.source, report(1, 'thread.opened')))
      const client_message_id = `pa:${p.conversation.id}:exec:0`
      await run(threads.processReport(a.source, report(2, 'turn.started', { worker_turn_seq: 1, client_message_id })))
      await run(threads.processReport(a.source, report(3, 'message.sent', { worker_turn_seq: 1, client_message_id })))
      await run(
        threads.processReport(
          a.source,
          report(4, 'reply', { worker_turn_seq: 1, content: 'done', metadata: { exit_code: 0 } }),
        ),
      )
      await run(
        threads.processReport(
          a.source,
          report(5, 'turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true }),
        ),
      )
      const event = result(P.ProjectEvent, await r.rpc('wait_tool', { last_seq: 2, tool_call_id: 'exec' }))
      expect(event.seq).toBe(3)
      expect((await run(projects.projectStatus(a.employee, p.id))).pending_inputs).toBe(0)
      expect(
        await r.rpc('call_tool', { last_seq: 2, tool_call_id: 'exec', tool_name: 'nodes.exec', arguments: args }),
      ).toEqual(event)
      expect(await r.rpc('claim_inputs', { last_seq: 3 })).toMatchObject({ input_count: 0 })
    }),
  30_000,
)

describe('node placement', () => {
  it(
    'falls back from an offline default without changing the saved default',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run)
        const { nodeId: otherNode } = await seedNode(run, {
          employeeId: a.employee,
          incarnation: 'inc-other',
          connId: 'conn-other',
          online: false,
          report: projectRuntimeReport,
        })
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO employee_settings(employee_id,default_device_node_id,updated_at) VALUES(${a.employee},${otherNode},now())`
          }),
        )
        const first = await a.create()
        await run(projects.acceptProjectMessage(a.employee, first.id, { client_message_id: 'first', content: 'start' }))
        await run(projects.scheduleProjectRun(first.agent.id))
        const [fallback] = await run(projects.claimProjectCommands('project_run_start'))
        expect(fallback!.node_id).toBe(a.node)
        const status = await run(projects.projectStatus(a.employee, first.id))
        expect(status.run?.placement_reason).toBe('default_offline')
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const [setting] = yield* sql<{
              default_device_node_id: string
            }>`SELECT default_device_node_id FROM employee_settings WHERE employee_id=${a.employee}`
            expect(setting!.default_device_node_id).toBe(otherNode)
          }),
        )
      }),
    30_000,
  )

  it(
    'enforces the four-run node capacity across concurrent placements',
    async () =>
      withTestDatabase(async ({ run }) => {
        const a = await fixture(run)
        const { nodeId: otherNode } = await seedNode(run, {
          employeeId: a.employee,
          incarnation: 'inc-other',
          connId: 'conn-other',
          online: true,
          report: projectRuntimeReport,
        })
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO employee_settings(employee_id,default_device_node_id,updated_at) VALUES(${a.employee},${a.node},now())`
          }),
        )
        const first = await a.create()
        await run(projects.acceptProjectMessage(a.employee, first.id, { client_message_id: 'first', content: 'start' }))
        await run(projects.scheduleProjectRun(first.agent.id))
        await run(projects.claimProjectCommands('project_run_start'))
        const pending: P.Project[] = []
        for (let i = 0; i < 5; i++) {
          const p = await a.create()
          await run(
            projects.acceptProjectMessage(a.employee, p.id, { client_message_id: `pending-${i}`, content: 'start' }),
          )
          pending.push(p)
        }
        await Promise.all(pending.map((p) => run(projects.scheduleProjectRun(p.agent.id))))
        const counts = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              node_id: string
              n: number
            }>`SELECT r.node_id,count(*)::integer AS n FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id WHERE r.employee_id=${a.employee} GROUP BY r.node_id`
          }),
        )
        expect(counts.find((c) => c.node_id === a.node)?.n).toBe(4)
        expect(counts.find((c) => c.node_id === otherNode)?.n).toBe(2)
      }),
    30_000,
  )
})
