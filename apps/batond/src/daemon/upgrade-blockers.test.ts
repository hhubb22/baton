import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { makeProjectLedger } from '../project/ledger.ts'

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
