import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'

export const PublicIdentity = Schema.Union([
  Schema.Struct({ registered: Schema.Literal(false) }),
  Schema.Struct({
    registered: Schema.Literal(true),
    coordinator_url: Schema.String,
    node_id: Schema.String,
    display_name: Schema.String,
    system: Schema.String,
  }),
])
export type PublicIdentity = typeof PublicIdentity.Type

export const DaemonStatus = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(['connecting', 'online', 'rejected', 'stopping']),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  updated_at: Schema.String,
})
export type DaemonStatus = typeof DaemonStatus.Type
export interface SupervisorState {
  state: 'stopped' | 'connecting' | 'restarting' | 'rejected' | 'external' | 'stopping'
  pid?: number
  code?: string
  message?: string
}
export type DesktopStatus = PublicIdentity & {
  state: SupervisorState['state'] | 'unregistered' | 'online'
  connection_state?: DaemonStatus['state']
  code?: string | undefined
  message?: string | undefined
}

export function mergeStatus(
  identity: PublicIdentity,
  supervisor: SupervisorState,
  daemon?: DaemonStatus,
): DesktopStatus {
  if (!identity.registered && supervisor.state !== 'rejected') return { ...identity, state: 'unregistered' }
  if (supervisor.state === 'external')
    return {
      ...identity,
      state: 'external',
      ...(daemon ? { connection_state: daemon.state, code: daemon.code, message: daemon.message } : {}),
    }
  if (supervisor.state === 'connecting' && daemon && daemon.pid === supervisor.pid)
    return {
      ...identity,
      state: daemon.state,
      code: daemon.code,
      message: daemon.message,
    }
  return { ...identity, state: supervisor.state, code: supervisor.code, message: supervisor.message }
}

export async function readDaemonRejection(
  directory: string,
  expectedPid: number | undefined,
  startedAt = 0,
): Promise<DaemonStatus | undefined> {
  if (expectedPid === undefined) return undefined
  try {
    const status = Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse(await readFile(join(directory, 'daemon-status.json'), 'utf8')),
    )
    return status.pid === expectedPid &&
      Date.parse(status.updated_at) >= startedAt &&
      status.state === 'rejected' &&
      ['needs_reauth', 'node_version_incompatible'].includes(status.code ?? '')
      ? status
      : undefined
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') throw error
    return undefined
  }
}

export async function readDaemonStatus(
  directory: string,
  alive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'EPERM'
    }
  },
): Promise<DaemonStatus | undefined> {
  try {
    const status = Schema.decodeUnknownSync(DaemonStatus)(
      JSON.parse(await readFile(join(directory, 'daemon-status.json'), 'utf8')),
    )
    const lock = join(directory, 'daemon.lock')
    const entries = await readdir(lock)
    if (entries.length !== 1 || !/^[\da-f-]{36}\.json$/.test(entries[0]!)) return undefined
    const record = Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Int, token: Schema.String }))(
      JSON.parse(await readFile(join(lock, entries[0]!), 'utf8')),
    )
    if (`${record.token}.json` !== entries[0] || status.pid !== record.pid || !alive(status.pid)) return undefined
    return status
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') throw error
    return undefined
  }
}
