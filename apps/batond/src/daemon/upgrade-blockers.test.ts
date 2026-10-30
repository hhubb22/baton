import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { makeProjectLedger } from '../project/ledger.ts'
import { openExecutionLedger } from '../execution/ledger.ts'
import { executionPaths } from '../execution/paths.ts'
import { upgradeLedgers } from './upgrade-check.ts'
import { checkStorageFormat } from '../storage-format.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'

const identity = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../platform/identity.ts', async (original) => ({
  ...(await original<typeof import('../platform/identity.ts')>()),
  readProcessIdentity: identity.read,
}))
const { upgradeBlockers } = await import('./upgrade.ts')

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('blocks upgrade for an unresolved Execution and counts its unacknowledged reports', async () => {
  const directory = await makePrivateTempDirectory('baton-upgrade-exec-')
  directories.push(directory)
  const id = randomUUID(),
    generation = randomUUID()
  const paths = executionPaths(directory, id)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* openExecutionLedger(paths.ledger)
        const command = {
          type: 'execution.command' as const,
          execution_id: id,
          action: 'start' as const,
          storage_generation: generation,
        }
        yield* ledger.save({
          command,
          intent: true,
          reports: [
            {
              acked: false,
              report: {
                type: 'execution.report',
                execution_id: id,
                event_id: randomUUID(),
                seq: 1,
                storage_generation: generation,
                status: 'running',
              },
            },
          ],
        })
      }),
    ),
  )
  expect(await upgradeBlockers(directory)).toMatchObject({
    blockers: expect.arrayContaining([{ kind: 'execution', id, reason: 'running' }]),
    pending_reports: 1,
  })
  const entry = (await upgradeLedgers(directory)).find((file) => file.kind === 'execution')!
  expect(entry.path).toBe(paths.ledger)
  expect(() => checkStorageFormat(entry.path, entry.kind, entry.baseline)).not.toThrow()
  const db = new DatabaseSync(paths.ledger)
  db.exec('UPDATE storage_format SET version=999')
  db.close()
  expect(() => checkStorageFormat(entry.path, entry.kind, entry.baseline)).toThrow('storage_version_unsupported')
})

it('只放行已确认退出或 pid 已复用的 Runtime 记录，身份查询失败仍阻碍升级', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-upgrade-blockers-'))
  directories.push(directory)
  const filename = join(directory, 'project-runtime.db')
  await Effect.runPromise(Effect.scoped(makeProjectLedger(filename)))
  const db = new DatabaseSync(filename)
  const records = { living: 101, exited: 102, reused: 103, failed: 104, unconfirmed: 105 }
  for (const [role, pid] of Object.entries(records))
    db.prepare('INSERT INTO project_processes VALUES(?,?)').run(
      role,
      JSON.stringify({ pid, creationTime: role === 'unconfirmed' ? 'unknown' : `t${pid}`, role }),
    )
  db.close()
  identity.read.mockImplementation(async (pid: number) => {
    if (pid === records.exited) return null
    if (pid === records.reused) return { pid, creationTime: 'other' }
    if (pid === records.failed) throw new Error('CIM query timed out')
    return { pid, creationTime: `t${pid}` }
  })

  const { blockers } = await upgradeBlockers(directory)

  expect(blockers.map((blocker) => blocker.id).sort()).toEqual(['failed', 'living', 'unconfirmed'])
  expect(blockers.every((blocker) => blocker.reason === 'runtime_cleanup_unconfirmed')).toBe(true)
})
