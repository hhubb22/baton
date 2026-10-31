import { join } from 'node:path'
import { Schema } from 'effect'
import { NodeUpdatePhase, PositiveInteger, UUID } from '@baton/protocol'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { lstat } from 'node:fs/promises'
import { programRoot } from '../platform/layout.ts'
import { isMissing } from './identity.ts'

export const UpdateState = Schema.Struct({
  operation_id: UUID,
  attempt: PositiveInteger,
  phase: NodeUpdatePhase,
  source_version: Schema.String,
  target_version: Schema.String,
  target_commit: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))),
  package_directory: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  previous_directory: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  desktop_managed: Schema.optionalKey(Schema.Boolean),
  rollback_complete: Schema.optionalKey(Schema.Boolean),
  startup_failed: Schema.optionalKey(Schema.Boolean),
  error_code: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
})
export type UpdateState = typeof UpdateState.Type

export const RollbackReceipt = Schema.Struct({
  operation_id: UUID,
  attempt: PositiveInteger,
  previous_directory: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  backup_checksum: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type RollbackReceipt = typeof RollbackReceipt.Type

export async function writeRollbackReceipt(directory: string, receipt: RollbackReceipt): Promise<void> {
  const value = Schema.decodeUnknownSync(RollbackReceipt)(receipt)
  await writePrivateFileAtomic(
    join(programRoot(directory), `rollback-completed-${value.operation_id}.json`),
    JSON.stringify(value),
  )
}

export async function readRollbackReceipt(
  directory: string,
  operationId: string,
): Promise<RollbackReceipt | undefined> {
  Schema.decodeUnknownSync(UUID)(operationId)
  try {
    return Schema.decodeUnknownSync(RollbackReceipt)(
      JSON.parse(
        (await readPrivateFile(join(programRoot(directory), `rollback-completed-${operationId}.json`))).toString(
          'utf8',
        ),
      ),
    )
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function readUpdateState(directory: string): Promise<UpdateState | undefined> {
  try {
    const bytes = await readPrivateFile(join(directory, 'update-progress.json'))
    if (bytes.length > 16384) throw new Error('invalid')
    return Schema.decodeUnknownSync(UpdateState)(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw new Error('更新状态无效')
  }
}

export async function saveUpdateState(directory: string, state: UpdateState): Promise<void> {
  await writePrivateFileAtomic(
    join(directory, 'update-progress.json'),
    JSON.stringify(Schema.decodeUnknownSync(UpdateState)(state)),
  )
}

export async function assertNoUpdateRollback(directory: string): Promise<void> {
  try {
    await lstat(join(programRoot(directory), 'rollback.json'))
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  throw new Error('设备更新回滚尚未完成')
}
