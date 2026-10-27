import { BUILD } from '@baton/protocol/release'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { processLockIsHeld } from '../platform/lock.ts'
import { isMissing } from './identity.ts'
import { IPCError, requestWorker } from './ipc.ts'
import { workerPaths } from './paths.ts'
import { readLedger } from '../worker/ledger.ts'
import { checkStorageFormat } from '../storage-format.ts'
import { storageBaseline as nodeBaseline } from './ledger.ts'
import { storageBaseline as projectBaseline } from '../project/ledger.ts'

export const UpgradeState = Schema.Struct({
  operation_id: Schema.String,
  source_version: Schema.String,
  target_version: Schema.String.check(Schema.isMinLength(1)),
  target_path: Schema.String,
  phase: Schema.Literals(['draining', 'ready', 'cancelled', 'failed']),
  reason: Schema.optionalKey(Schema.String),
})
export type UpgradeState = typeof UpgradeState.Type
export interface UpgradeBlocker {
  kind: 'thread' | 'runtime' | 'process'
  id: string
  reason: string
  pid?: number
  creation_time?: string
}

export async function readUpgradeState(dataDirectory: string): Promise<UpgradeState | undefined> {
  try {
    return Schema.decodeUnknownSync(UpgradeState)(
      JSON.parse((await readPrivateFile(join(dataDirectory, 'upgrade.json'))).toString('utf8')),
    )
  } catch (error) {
    if (isMissing(error)) return undefined
    throw new IPCError('upgrade_state_invalid', '无法读取升级状态，执行保持暂停')
  }
}
export async function upgradePaused(dataDirectory?: string): Promise<boolean> {
  if (!dataDirectory) return false
  const state = await readUpgradeState(dataDirectory)
  return state !== undefined && state.phase !== 'cancelled'
}
export const saveUpgradeState = (directory: string, state: UpgradeState) =>
  writePrivateFileAtomic(join(directory, 'upgrade.json'), JSON.stringify(state))

export async function prepareUpgrade(directory: string, target: string): Promise<UpgradeState> {
  const path = await realpath(target)
  const release = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String.check(Schema.isMinLength(1)) }))(
    JSON.parse(await readFile(join(path, 'release.json'), 'utf8')),
  )
  const previous = await readUpgradeState(directory)
  if (previous && previous.phase !== 'cancelled') {
    if (previous.target_path !== path || previous.target_version !== release.version)
      throw new IPCError('upgrade_conflict', '已有不同目标的升级准备')
    return previous
  }
  const state: UpgradeState = {
    operation_id: randomUUID(),
    source_version: BUILD.version,
    target_version: release.version,
    target_path: path,
    phase: 'draining',
  }
  await saveUpgradeState(directory, state)
  return state
}

/** 只读检查持久执行事实；存活的锁或未确认的进程记录都阻止就绪。 */
export async function upgradeBlockers(
  directory: string,
): Promise<{ blockers: UpgradeBlocker[]; pending_reports: number }> {
  const blockers: UpgradeBlocker[] = []
  let pending = 0
  let threads: string[] = []
  try {
    threads = await readdir(join(directory, 'threads'))
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const id of threads) {
    if (!Schema.is(Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i)))(id)) continue
    const paths = workerPaths(directory, id)
    try {
      if ((await processLockIsHeld(paths.lock)) || (await processLockIsHeld(paths.launchLock)))
        blockers.push({ kind: 'thread', id, reason: 'worker_alive' })
      try {
        await stat(paths.ledger)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      const state = readLedger(paths.ledger).initial
      if (state.activeMessage || ['stopping', 'unknown'].includes(state.phase))
        blockers.push({ kind: 'thread', id, reason: state.phase })
      for (const record of Object.values(state.processes))
        blockers.push({
          kind: 'process',
          id: String(record.pid),
          pid: record.pid,
          creation_time: record.creationTime,
          reason: `${id}:${record.role}:cleanup_unconfirmed`,
        })
      pending += state.outbox.filter((row) => !row.acked).length
    } catch {
      blockers.push({ kind: 'thread', id, reason: 'inspection_failed' })
    }
  }
  for (const [filename, table] of [
    ['project-runtime.db', 'project_processes'],
    ['node.db', 'node_outbox'],
  ] as const) {
    let db: DatabaseSync | undefined
    try {
      await stat(join(directory, filename))
      checkStorageFormat(
        join(directory, filename),
        table === 'project_processes' ? 'project' : 'node',
        table === 'project_processes' ? projectBaseline : nodeBaseline,
      )
      db = new DatabaseSync(join(directory, filename), { readOnly: true })
      if (table === 'project_processes') {
        for (const row of db
          .prepare("SELECT run_id FROM project_runtime_runs WHERE cleanup_complete=0 AND state!='queued'")
          .all())
          blockers.push({ kind: 'runtime', id: String(row.run_id), reason: 'runtime_or_cleanup_pending' })
        for (const row of db.prepare('SELECT role, payload FROM project_processes').all()) {
          const record = Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Int, creationTime: Schema.String }))(
            JSON.parse(String(row.payload)),
          )
          blockers.push({
            kind: 'process',
            id: String(row.role),
            pid: record.pid,
            creation_time: record.creationTime,
            reason: 'runtime_cleanup_unconfirmed',
          })
        }
      } else pending += Number(db.prepare('SELECT count(*) AS n FROM node_outbox WHERE acked=0').get()!.n)
    } catch (error) {
      if (!isMissing(error)) blockers.push({ kind: 'process', id: filename, reason: 'inspection_failed' })
    } finally {
      db?.close()
    }
  }
  let probes: string[] = []
  try {
    probes = await readdir(join(directory, 'agent-probes'))
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const agent of probes) {
    const root = join(directory, 'agent-probes', agent)
    try {
      if (await processLockIsHeld(join(root, 'probe.lock')))
        blockers.push({ kind: 'process', id: agent, reason: 'probe_alive' })
      const records = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ pid: Schema.Int, creationTime: Schema.String, role: Schema.String })),
      )(JSON.parse((await readPrivateFile(join(root, 'processes.json'))).toString('utf8')))
      for (const record of records)
        blockers.push({
          kind: 'process',
          id: record.role,
          pid: record.pid,
          creation_time: record.creationTime,
          reason: 'probe_cleanup_unconfirmed',
        })
    } catch (error) {
      if (!isMissing(error)) blockers.push({ kind: 'process', id: agent, reason: 'inspection_failed' })
    }
  }
  return { blockers, pending_reports: pending }
}

export function upgradePaths(directory: string) {
  const root = resolve(directory)
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24)
  return {
    token: join(root, 'daemon.token'),
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\baton-daemon-${id}` : join(root, 'ipc', `daemon-${id}.sock`),
  }
}
export async function requestUpgrade(
  directory: string,
  type: 'upgrade_prepare' | 'upgrade_status' | 'upgrade_cancel',
  target?: string,
) {
  const paths = upgradePaths(directory)
  const result = await requestWorker({
    endpoint: paths.endpoint,
    token: (await readPrivateFile(paths.token)).toString('utf8'),
    request: type === 'upgrade_prepare' ? { type, ok: false, payload: target! } : { type, ok: false },
    timeoutMs: 10000,
  })
  if (!result.ok) throw new IPCError(result.code ?? 'upgrade_failed', result.message ?? '升级请求失败')
  return JSON.parse(result.payload ?? '{}') as unknown
}
