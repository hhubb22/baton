import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import { createDatabaseRuntime } from './database.ts'
import { openTestDatabase, type TestDatabase } from './test-database.ts'
import { compensateRevocations, createRevocationCompensator } from './control-maintenance.ts'

async function database(test: (db: TestDatabase) => Promise<void>) {
  const db = await openTestDatabase()
  try {
    await test(db)
  } finally {
    await db.close()
  }
}
async function employee(db: TestDatabase) {
  return db.run(Auth.createEmployee('u' + randomUUID().replaceAll('-', ''), 'Employee', 'offline-maintenance-password'))
}
async function node(db: TestDatabase, owner: Auth.Employee, connect = false) {
  const signer = Nodes.CredentialSigner.generate()
  const enrollment = await db.run(Nodes.issueEnrollment(owner.id))
  const identity = await db.run(
    Nodes.registerNode(
      {
        enrollment_token: String(enrollment.enrollment_token),
        display_name: 'Device',
        system: 'linux',
        capabilities: [],
      },
      signer,
    ),
  )
  const source = {
    employee_id: owner.id,
    node_id: identity.node_id,
    credential_id: identity.credential.id,
    incarnation: randomUUID(),
    conn_id: randomUUID(),
  }
  if (connect) await db.run(Nodes.claimConnection(source))
  return { identity, source }
}

it('finishes persisted revocation after startup reset and keeps disconnect outside database locks', () =>
  database(async (db) => {
    const owner = await employee(db)
    const { identity } = await node(db, owner, true)
    expect((await db.run(Nodes.revokeNode(owner.id, identity.node_id))).status).toBe('pending')
    await db.run(Nodes.resetConnections())
    const restarted = createDatabaseRuntime({ url: db.url, schema: db.schema })
    const run = async <A>(effect: import('./database.ts').DatabaseEffect<A>) => {
      const result = await restarted.runPromise(
        Effect.match(effect, {
          onFailure: (error) => ({ error, ok: false }) as const,
          onSuccess: (value) => ({ value, ok: true }) as const,
        }),
      )
      if (!result.ok) throw result.error
      return result.value
    }
    const calls: string[] = []
    try {
      const result = await compensateRevocations(run, async (nodeId) => {
        calls.push(nodeId)
        await db.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT id FROM nodes WHERE id=${nodeId}::uuid FOR UPDATE NOWAIT`
                yield* sql`SELECT node_id FROM node_presence WHERE node_id=${nodeId}::uuid FOR UPDATE NOWAIT`
              }),
            )
          }),
        )
      })
      expect(result).toMatchObject({ attempted: 1, applied: 1, failed: 0 })
      expect(calls).toEqual([identity.node_id])
      expect((await run(Nodes.getRevocation(owner.id, identity.node_id))).status).toBe('effective')
      const saved = await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            applied_at: Date
          }>`SELECT applied_at FROM node_revocations WHERE node_id=${identity.node_id}::uuid`
        }),
      )
      expect(
        await compensateRevocations(run, async (id) => {
          calls.push(id)
        }),
      ).toMatchObject({ attempted: 0, applied: 0, failed: 0 })
      expect(calls).toHaveLength(1)
      const after = await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            applied_at: Date
          }>`SELECT applied_at FROM node_revocations WHERE node_id=${identity.node_id}::uuid`
        }),
      )
      expect(after).toEqual(saved)
    } finally {
      await restarted.dispose()
    }
  }))

it('retains failed disconnect intent and retries it on the next scan', () =>
  database(async (db) => {
    const owner = await employee(db)
    const { identity, source } = await node(db, owner, true)
    await db.run(Nodes.revokeNode(owner.id, identity.node_id))
    let attempts = 0
    const compensate = createRevocationCompensator(db.run, async () => {
      if (++attempts === 1) throw new Error('temporary disconnect failure')
      await db.run(Nodes.disconnectNode(source))
    })
    expect(await compensate()).toMatchObject({ attempted: 1, applied: 0, failed: 1 })
    expect((await db.run(Nodes.getRevocation(owner.id, identity.node_id))).status).toBe('pending')
    expect(await compensate()).toMatchObject({ attempted: 1, applied: 1, failed: 0 })
    expect(attempts).toBe(2)
    expect((await db.run(Nodes.getRevocation(owner.id, identity.node_id))).status).toBe('effective')
  }))

it('requires presence to be offline before confirming a successful disconnect callback', () =>
  database(async (db) => {
    const owner = await employee(db)
    const { identity, source } = await node(db, owner, true)
    await db.run(Nodes.revokeNode(owner.id, identity.node_id))
    expect(await compensateRevocations(db.run, async () => {})).toMatchObject({ attempted: 1, applied: 0, failed: 1 })
    expect((await db.run(Nodes.getRevocation(owner.id, identity.node_id))).status).toBe('pending')
    expect(
      await compensateRevocations(db.run, async () => {
        await db.run(Nodes.disconnectNode(source))
      }),
    ).toMatchObject({ attempted: 1, applied: 1, failed: 0 })
    expect((await db.run(Nodes.getRevocation(owner.id, identity.node_id))).status).toBe('effective')
  }))

it('advances past a failing full batch and bounds batch size, concurrency and overlapping scans', () =>
  database(async (db) => {
    const owner = await employee(db)
    const ids: string[] = []
    for (let i = 0; i < 35; i++) {
      const { identity } = await node(db, owner)
      ids.push(identity.node_id)
      await db.run(Nodes.revokeNode(owner.id, identity.node_id))
      await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE node_revocations SET requested_at=clock_timestamp()-make_interval(secs=>${1000 - i}) WHERE node_id=${identity.node_id}::uuid`
        }),
      )
    }
    expect((await db.run(Nodes.pendingRevocations())).map((item) => item.node_id)).toEqual(ids.slice(0, 32))
    const calls: string[] = []
    let active = 0,
      maximum = 0
    const compensate = createRevocationCompensator(db.run, async (id) => {
      active++
      maximum = Math.max(maximum, active)
      try {
        calls.push(id)
        await Promise.resolve()
        if (ids.indexOf(id) < 32) throw new Error('node remains unavailable')
      } finally {
        active--
      }
    })
    const first = compensate()
    expect(compensate()).toBe(first)
    expect(await first).toMatchObject({ attempted: 32, applied: 0, failed: 32 })
    expect(calls).toEqual(ids.slice(0, 32))
    expect(maximum).toBeLessThanOrEqual(4)
    expect(await compensate()).toMatchObject({ attempted: 3, applied: 3, failed: 0 })
    expect(calls.slice(32)).toEqual(ids.slice(32))
    expect(await compensate()).toMatchObject({ attempted: 32, applied: 0, failed: 32 })
    for (const id of ids.slice(32)) expect((await db.run(Nodes.getRevocation(owner.id, id))).status).toBe('effective')
  }))

it('merges credentials per node and rejects unbounded page requests', () =>
  database(async (db) => {
    const owner = await employee(db)
    const { identity } = await node(db, owner)
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO node_credentials(id,node_id,employee_id,version,created_at,expires_at) VALUES(${randomUUID()}::uuid,${identity.node_id}::uuid,${owner.id}::uuid,2,now(),now()+interval '1 day')`
      }),
    )
    await db.run(Nodes.revokeNode(owner.id, identity.node_id))
    const pending = await db.run(Nodes.pendingRevocations(1))
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ node_id: identity.node_id, employee_id: owner.id })
    await expect(db.run(Nodes.pendingRevocations(33))).rejects.toMatchObject({ status: 400 })
    await expect(db.run(Nodes.pendingRevocations(0))).rejects.toMatchObject({ status: 400 })
    let disconnected = 0
    expect(
      await compensateRevocations(db.run, async () => {
        disconnected++
      }),
    ).toMatchObject({ attempted: 1, applied: 1, failed: 0 })
    expect(disconnected).toBe(1)
    expect(
      await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            count: number
          }>`SELECT count(*)::integer AS count FROM node_revocations WHERE node_id=${identity.node_id}::uuid AND applied_at IS NOT NULL`
        }),
      ),
    ).toEqual([{ count: 2 }])
  }))
