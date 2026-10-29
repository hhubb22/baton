import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase } from './testing/database.ts'
import { projectToolFixture } from './testing/project-tools.ts'
import { transaction } from './database.ts'
import { AppError } from './errors.ts'
import { lockNodeSource, revokeNode } from './nodes.ts'
import * as threads from './threads/index.ts'
import { randomUUID } from 'node:crypto'
import { releaseProjectRun, projectTransaction } from './project/store.ts'
import { claimNotificationBroadcasts, replayNotifications, saveNotification } from './desktop-notifications.ts'

it('replays committed employee events in cursor order across retry, pagination, publication and restart', () =>
  withTestDatabase(async ({ run, restart }) => {
    const a = await seedNode(run)
    const b = await seedNode(run)
    const notice = { kind: 'question' as const, node_id: a.nodeId, title: 'Work', body: 'Choose a target.' }
    expect(await run(replayNotifications(a.employeeId))).toEqual({ events: [], cursor: '0', has_more: false })
    await expect(
      run(
        transaction(
          Effect.gen(function* () {
            yield* saveNotification(a.employeeId, 'rolled-back', notice)
            return yield* Effect.fail(new AppError(409, 'rollback'))
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'rollback' })
    expect((await run(replayNotifications(a.employeeId, '0'))).events).toEqual([])

    const first = await run(saveNotification(a.employeeId, 'first', notice))
    expect(await run(saveNotification(a.employeeId, 'first', notice))).toEqual(first)
    await Promise.all(
      Array.from({ length: 4 }, (_, i) => run(saveNotification(a.employeeId, `concurrent:${i}`, notice))),
    )
    await run(saveNotification(b.employeeId, 'private', { ...notice, title: 'Private' }))
    const baseline = await run(replayNotifications(a.employeeId))
    expect(baseline).toEqual({ events: [], cursor: '5', has_more: false })
    const page = await run(replayNotifications(a.employeeId, '0', 2))
    expect(page).toMatchObject({ cursor: '2', has_more: true })
    expect(page.events.map((event) => event.cursor)).toEqual(['1', '2'])
    expect(page.events[0]?.event_id).toBe(first)
    expect(Schema.is(P.BrowserEvent)(page.events[0])).toBe(true)
    expect(await run(saveNotification(a.employeeId, 'first', notice))).toBe(first)
    const broadcasts = await run(claimNotificationBroadcasts())
    expect(broadcasts).toHaveLength(6)
    expect(await run(claimNotificationBroadcasts())).toEqual([])
    const recovered = await restart()
    const all = await recovered(replayNotifications(a.employeeId, '0'))
    expect(all.events.map((event) => event.cursor)).toEqual(['1', '2', '3', '4', '5'])
    expect(all.events[0]?.event_id).toBe(first)
    expect(all.events.every((event) => event.title === 'Work')).toBe(true)
    await expect(recovered(replayNotifications(b.employeeId, '5'))).rejects.toMatchObject({ code: 'invalid_cursor' })
  }))

it('keeps uncommitted intent behind the replay watermark', () =>
  withTestDatabase(async ({ run }) => {
    const a = await seedNode(run)
    let allocated!: () => void
    let commit!: () => void
    const ready = new Promise<void>((resolve) => {
      allocated = resolve
    })
    const released = new Promise<void>((resolve) => {
      commit = resolve
    })
    const input = { kind: 'question' as const, title: 'Work', body: 'Reply' }
    const first = run(
      transaction(
        Effect.gen(function* () {
          yield* saveNotification(a.employeeId, 'one', input)
          allocated()
          yield* Effect.promise(() => released)
        }),
      ),
    )
    try {
      await ready
      expect(await run(replayNotifications(a.employeeId, '0'))).toEqual({ events: [], cursor: '0', has_more: false })
      const second = await run(saveNotification(a.employeeId, 'two', input))
      const committed = await run(replayNotifications(a.employeeId, '0'))
      expect(committed.events.map((event) => event.event_id)).toEqual([second])
      expect(committed.cursor).toBe('1')
    } finally {
      commit()
      await first
    }
    const late = await run(replayNotifications(a.employeeId, '1'))
    expect(late.cursor).toBe('2')
    expect(late.events).toHaveLength(1)
  }))

it('excludes committed unsequenced history from the first baseline and delivers later intent', () =>
  withTestDatabase(async ({ run }) => {
    const a = await seedNode(run)
    const input = { kind: 'question' as const, title: 'Work', body: 'Reply' }
    const historical = await run(saveNotification(a.employeeId, 'history', input))
    const counters = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT employee_id FROM browser_notification_cursors WHERE employee_id=${a.employeeId}`
      }),
    )
    expect(counters).toEqual([])
    const baseline = await run(replayNotifications(a.employeeId))
    expect(baseline).toEqual({ events: [], cursor: '1', has_more: false })
    expect((await run(claimNotificationBroadcasts())).map((row) => row.event.event_id)).toEqual([historical])
    expect(await run(replayNotifications(a.employeeId, baseline.cursor))).toEqual({
      events: [],
      cursor: '1',
      has_more: false,
    })
    const fresh = await run(saveNotification(a.employeeId, 'fresh', input))
    const page = await run(replayNotifications(a.employeeId, baseline.cursor))
    expect(page.events.map((event) => event.event_id)).toEqual([fresh])
    expect(page.cursor).toBe('2')
  }))

it('finishes a Node-locked Thread report while Project release waits for that Node', () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const clientMessageId = randomUUID()
    const { thread } = await db.run(
      threads.create(c.employeeId, {
        client_thread_id: randomUUID(),
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work',
        message: { client_message_id: clientMessageId, content: 'Standalone work' },
      }),
    )
    const report = (
      worker_seq: number,
      kind: P.ThreadReport['kind'],
      extra: Partial<P.ThreadReport> = {},
    ): P.ThreadReport => ({
      type: 'thread.report',
      thread_id: thread.id,
      event_id: randomUUID(),
      worker_seq,
      kind,
      storage_generation: 'generation',
      ...extra,
    })
    await db.run(threads.processReport(c.source, report(1, 'thread.opened')))
    await db.run(
      threads.processReport(
        c.source,
        report(2, 'turn.started', { worker_turn_seq: 1, client_message_id: clientMessageId }),
      ),
    )
    let nodeLocked!: () => void
    let projectStaged!: () => void
    const locked = new Promise<void>((resolve) => {
      nodeLocked = resolve
    })
    const staged = new Promise<void>((resolve) => {
      projectStaged = resolve
    })
    const reportWriter = db.run(
      transaction(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`SET LOCAL lock_timeout='3s'`
          yield* lockNodeSource(c.source)
          nodeLocked()
          yield* Effect.promise(() => staged)
          yield* threads.processReport(
            c.source,
            report(3, 'turn.ended', {
              worker_turn_seq: 1,
              reason: 'completed',
              queue_empty: true,
            }),
          )
        }),
      ),
    )
    await locked
    const projectWriter = db
      .run(
        projectTransaction(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`SET LOCAL lock_timeout='3s'`
            yield* releaseProjectRun(c.agentId, 'lost', 'lease_expired')
            projectStaged()
            yield* sql`SELECT id FROM nodes WHERE id=${nodeId} FOR UPDATE`
          }),
        ),
      )
      .finally(projectStaged)
    await Promise.all([reportWriter, projectWriter])
    const { events } = await db.run(replayNotifications(c.employeeId, '0'))
    expect(events.map((event) => event.kind).sort()).toEqual(['turn_ended', 'turn_stopped'])
    expect(events.find((event) => event.thread_id === thread.id)?.body).toBe('Cursor finished replying.')
    expect(events.find((event) => event.project_id === c.projectId)?.body).toBe(
      'Project assistant stopped unexpectedly: The project assistant connection expired.',
    )
  }))

it.each(['finished', 'failed'] as const)('records Project %s replies and credential revocation once', (state) =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    await db.run(projectTransaction(releaseProjectRun(c.agentId, state, state === 'failed' ? 'failed' : '')))
    await db.run(projectTransaction(releaseProjectRun(c.agentId, state, state === 'failed' ? 'failed' : '')))
    await db.run(revokeNode(c.employeeId, nodeId))
    await db.run(revokeNode(c.employeeId, nodeId))
    const { events } = await db.run(replayNotifications(c.employeeId, '0'))
    expect(events.map((event) => event.kind)).toEqual([
      state === 'finished' ? 'turn_ended' : 'turn_failed',
      'device_rejected',
    ])
    expect(events[0]!.body).toBe(
      state === 'finished' ? 'Project assistant finished replying.' : 'Project assistant could not finish replying.',
    )
    expect(events[1]).toMatchObject({ node_id: nodeId })
  }),
)
