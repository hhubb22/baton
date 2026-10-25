import { Schema } from 'effect'
import { CommandOutcome, PositiveInteger, StorageGeneration, UUID, boundedText } from './common.ts'
import { ThreadCommand, ThreadCommandResult, ThreadReport } from './thread.ts'

export const CommandCompleted = ThreadReport.mapFields(
  (fields) => ({
    ...fields,
    kind: Schema.Literal('command.completed'),
    command_id: UUID,
    command_outcome: CommandOutcome,
    storage_generation: StorageGeneration,
    worker_seq: PositiveInteger,
    reason: boundedText(4096),
  }),
  { unsafePreserveChecks: true },
)
export type CommandCompleted = typeof CommandCompleted.Type

export const ThreadOpenCommandResult = ThreadCommandResult.check(
  Schema.makeFilter((value) => !value.ok || value.storage_generation !== undefined || 'open 成功回执缺少存储代次'),
)
export type ThreadOpenCommandResult = typeof ThreadOpenCommandResult.Type

// 中心从持久命令和经过认证的节点身份取得这些值。
export type CommandIdentity = {
  readonly command_id: string
  readonly thread_id: string
  readonly node_id: string
  readonly storage_generation: string
}

export function isCommandCompletionFor(
  expected: CommandIdentity,
  report: unknown,
  sourceNodeID: string,
): report is CommandCompleted {
  return (
    Schema.is(CommandCompleted)(report) &&
    report.command_id === expected.command_id &&
    report.thread_id === expected.thread_id &&
    report.storage_generation === expected.storage_generation &&
    sourceNodeID === expected.node_id
  )
}

export function isCommandReceiptFor(command: ThreadCommand, result: unknown): result is ThreadCommandResult {
  return (
    Schema.is(ThreadCommandResult)(result) &&
    result.thread_id === command.thread_id &&
    (command.action !== 'open' || Schema.is(ThreadOpenCommandResult)(result))
  )
}
