import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import { type NodeSource } from './errors.ts'
import { openTestDatabase, seedNodeIdentity, type TestDatabase } from './testing/database.ts'

let db: TestDatabase
let employee: Auth.Employee
const signer = Nodes.CredentialSigner.generate()
const sync = { display_name: 'Workstation', system: 'linux', capabilities: [] }
const run: TestDatabase['run'] = (effect) => db.run(effect)
const query = (text: string, parameters: readonly unknown[] = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe(text, parameters)
  })
async function register() {
  const { identity } = await seedNodeIdentity(run, signer, {
    employeeId: employee.id,
    displayName: sync.display_name,
    system: 'linux',
  })
  const source: NodeSource = {
    node_id: identity.node_id,
    employee_id: identity.employee_id,
    credential_id: identity.credential.id,
    incarnation: randomUUID(),
    conn_id: randomUUID(),
  }
  await run(Nodes.claimConnection(source))
  await run(Nodes.syncNode(source, sync))
  return { identity, source }
}
const business = (source: NodeSource) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Nodes.lockNodeSource(source)
        yield* Nodes.recordNodeBusiness(source)
      }),
    )
  })

beforeAll(async () => {
  db = await openTestDatabase()
  employee = await run(Auth.createEmployee('lifetime', 'Lifetime', 'offline-password-123'))
}, 30000)
afterAll(async () => {
  await db?.close()
})

it('keeps credentials valid after long inactivity until they are revoked', async () => {
  const { identity, source } = await register()
  const jwt = JSON.parse(Buffer.from(identity.credential.token.split('.')[1]!, 'base64url').toString())
  expect(jwt.exp).toBeUndefined()
  await run(
    query("UPDATE node_credentials SET created_at=clock_timestamp()-interval '366 days' WHERE id=$1", [
      identity.credential.id,
    ]),
  )
  await run(Nodes.authenticateNode(identity.credential.token, signer))
  await run(Nodes.touchNode(source))
  await run(business(source))
  await run(Nodes.disconnectNode(source))
  const reconnected = { ...source, conn_id: randomUUID() }
  await run(Nodes.claimConnection(reconnected))
  await run(Nodes.syncNode(reconnected, sync))
  expect(await run(Nodes.getNode(employee.id, identity.node_id))).toMatchObject({
    credential_state: 'active',
    executable: true,
  })

  await run(query('UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=$1', [identity.credential.id]))
  await expect(run(Nodes.authenticateNode(identity.credential.token, signer))).rejects.toMatchObject({
    code: 'credential_revoked',
  })
  await expect(run(Nodes.claimConnection({ ...source, conn_id: randomUUID() }))).rejects.toMatchObject({
    code: 'node_source_rejected',
  })
  expect(await run(Nodes.getNode(employee.id, identity.node_id))).toMatchObject({
    credential_state: 'revoked',
    executable: false,
  })
})
