import { randomUUID } from 'node:crypto'
import { Effect, Exit, Logger, Metric, References } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase } from './testing/database.ts'
import { collectServerMetrics, makeMemoryWaitObserver, makeProjectWaitObserver } from './telemetry.ts'
import { acceptProjectMessage, createProject } from './project/projects.ts'

it('publishes current counts and zero for an empty outbox', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run)
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* collectServerMetrics()
        const online = yield* Metric.value(Metric.gauge('baton.nodes.online'))
        const queue = yield* Metric.value(
          Metric.withAttributes(Metric.gauge('baton.outbox.pending'), { 'baton.command.action': 'message' }),
        )
        yield* sql`UPDATE node_presence SET online=false WHERE node_id=${node.nodeId}`
        yield* sql`ALTER TABLE thread_events RENAME TO thread_events_hidden`
        const failed = yield* Effect.exit(collectServerMetrics())
        const unchanged = (yield* Metric.value(Metric.gauge('baton.nodes.online'))).value
        yield* sql`ALTER TABLE thread_events_hidden RENAME TO thread_events`
        yield* collectServerMetrics()
        return {
          online: online.value,
          queue: queue.value,
          failed: Exit.isFailure(failed),
          unchanged,
          recovered: (yield* Metric.value(Metric.gauge('baton.nodes.online'))).value,
        }
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    )
    expect(result.online).toBe(1)
    expect(result.queue).toBe(0)
    expect(result.failed).toBe(true)
    expect(result.unchanged).toBe(1)
    expect(result.recovered).toBe(0)
    expect(node.nodeId).toBeDefined()
  })
})

it('observes foreground Project waiting transitions using the status calculation', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, {
      online: false,
      report: {
        project_runtime: { version: '1', providers: [{ provider: 'openai-codex', status: 'available' }] },
        roots: [],
        repos: [],
        exec: { enabled: false, shell: '/bin/sh' },
      },
    })
    const project = await run(
      createProject(node.employeeId, { title: 'Waiting', provider: 'openai-codex', model: 'gpt-5' }),
    )
    await run(acceptProjectMessage(node.employeeId, project.id, { client_message_id: randomUUID(), content: 'start' }))
    const logs: Array<{ message: unknown; attributes: Readonly<Record<string, unknown>> }> = []
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const observer = makeProjectWaitObserver()
        yield* observer.poll
        yield* sql`UPDATE node_presence SET online=true,synced=true WHERE node_id=${node.nodeId}`
        yield* observer.poll
      }).pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(({ message, fiber }) =>
              logs.push({ message, attributes: fiber.getRef(References.CurrentLogAnnotations) }),
            ),
          ]),
        ),
      ),
    )
    expect(logs.map((entry) => [entry.message, entry.attributes['baton.wait.reason']])).toEqual([
      [['baton.wait.start'], 'device_offline'],
      [['baton.wait.end'], 'device_offline'],
      [['baton.wait.start'], 'queue'],
    ])
  })
})

it('logs memory wait changes with fixed reasons and clears the prior metric series', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run)
    const project = await run(
      createProject(node.employeeId, { title: 'Memory', provider: 'openai-codex', model: 'gpt-5' }),
    )
    const id = randomUUID()
    const logs: Array<{ message: unknown; attributes: Readonly<Record<string, unknown>> }> = []
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq,waiting_reason) VALUES(${id},${node.employeeId},${project.id},${project.conversation.id},'embedding',0,0,'login_required')`
        const observe = makeMemoryWaitObserver()
        yield* observe
        yield* collectServerMetrics()
        const gauge = Metric.withAttributes(Metric.gauge('baton.memory.jobs'), {
          'baton.memory.job.state': 'pending',
          'baton.wait.reason': 'credential_missing',
        })
        const before = (yield* Metric.value(gauge)).value
        yield* sql`UPDATE project_memory_jobs SET state='completed' WHERE id=${id}`
        yield* observe
        yield* collectServerMetrics()
        return { before, after: (yield* Metric.value(gauge)).value }
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(({ message, fiber }) =>
              logs.push({ message, attributes: fiber.getRef(References.CurrentLogAnnotations) }),
            ),
          ]),
        ),
      ),
    )
    expect(result).toEqual({ before: 1, after: 0 })
    expect(logs.map((entry) => entry.message)).toEqual([['baton.wait.start'], ['baton.wait.end']])
    expect(logs.every((entry) => entry.attributes['baton.wait.reason'] === 'credential_missing')).toBe(true)
    expect(logs[1]!.attributes['baton.wait.duration_ms']).toEqual(expect.any(Number))
  })
})
