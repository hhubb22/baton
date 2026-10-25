import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Schema } from 'effect'
import type { WorkerOpenConfig } from '@baton/protocol'
import { UUID, PositiveInteger, FullOutputReference } from '@baton/protocol'
import { ensurePrivateDirectory, openPrivateFile, writePrivateFileAtomic } from '../../platform/private.ts'
import { AgentError, type AgentMessage, type InputPreparation } from '../../worker/agent.ts'
import { outputBytes, type CommandOutput } from './output.ts'

const Origin = Schema.Struct({
  project_id: UUID,
  origin_conversation_id: UUID,
  origin_tool_call_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
})
const Mapping = Schema.Struct({
  version: Schema.Literal(1),
  threadId: UUID,
  nodeId: UUID,
  storageGeneration: UUID,
  nativeSessionId: UUID,
  cwd: Schema.String,
  statePath: Schema.String,
  timeoutSeconds: PositiveInteger,
  origin: Origin,
})
export type ShellMapping = typeof Mapping.Type
const Result = Schema.Struct({
  output: Schema.String,
  encoding: Schema.optionalKey(Schema.Literal('base64')),
  exit_code: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  total_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
  full_output: Schema.optionalKey(FullOutputReference),
})
const Completion = Schema.Struct({
  version: Schema.Literal(1),
  mapping: Mapping,
  messageId: Schema.String,
  preparationId: Schema.String,
  executionId: Schema.String,
  completionKind: Schema.Literals(['exited', 'stopped']),
  processTreeStopped: Schema.Literal(true),
  result: Result,
})
export type ShellCompletion = typeof Completion.Type

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function statePath(config: WorkerOpenConfig): string {
  const path = config.adapter_config.state_path
  if (!path || !isAbsolute(path)) throw new AgentError('shell requires an absolute private state_path')
  return resolve(path)
}

export function mappingFor(config: WorkerOpenConfig, nativeSessionId: string, cwd: string): ShellMapping {
  if (config.agent_type !== 'shell' || config.model || config.adapter_config.model)
    throw new AgentError('shell requires agent_type shell and does not accept models')
  if (
    !Number.isInteger(config.execution_timeout_seconds) ||
    config.execution_timeout_seconds < 1 ||
    config.execution_timeout_seconds > 2147483647
  )
    throw new AgentError('shell execution timeout must be between 1 and 2147483647 seconds')
  return Schema.decodeUnknownSync(Mapping)({
    version: 1,
    threadId: config.thread_id,
    nodeId: config.node_id,
    storageGeneration: config.storage_generation,
    nativeSessionId,
    cwd,
    statePath: statePath(config),
    timeoutSeconds: config.execution_timeout_seconds,
    origin: Schema.decodeUnknownSync(Origin)(config),
  })
}

/** Opens a checked private file and bounds allocation before reading. */
export async function readJson(path: string, limit: number): Promise<unknown> {
  const file = await openPrivateFile(path)
  try {
    if ((await file.stat()).size > limit) throw new AgentError('shell evidence exceeds size limit')
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset <= limit) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit || !isUtf8(bytes.subarray(0, offset)))
      throw new AgentError('Invalid shell evidence encoding or size')
    const text = bytes.subarray(0, offset).toString('utf8')
    const value: unknown = JSON.parse(text)
    if (JSON.stringify(value) !== text)
      throw new AgentError('shell evidence must use its canonical single-document encoding')
    return value
  } finally {
    await file.close()
  }
}

export async function loadMapping(config: WorkerOpenConfig): Promise<ShellMapping> {
  const mapping = Schema.decodeUnknownSync(Mapping)(await readJson(statePath(config), 16 * 1024))
  const expected = mappingFor(config, mapping.nativeSessionId, mapping.cwd)
  if (JSON.stringify(mapping) !== JSON.stringify(expected)) throw new AgentError('shell mapping identity mismatch')
  return mapping
}

export async function persistMapping(mapping: ShellMapping): Promise<void> {
  await ensurePrivateDirectory(dirname(mapping.statePath))
  await writePrivateFileAtomic(mapping.statePath, JSON.stringify(mapping))
}

export function prepare(message: AgentMessage, mapping: ShellMapping, confirmedSends: number): InputPreparation {
  if (message.mode !== 'queue' || message.model || !message.id || !message.text)
    throw new AgentError('shell only accepts one queued command without a model')
  return {
    nativeSessionId: mapping.nativeSessionId,
    preparationId: digest({ mapping, message }),
    confirmedSends,
  }
}

export function validatePreparation(message: AgentMessage, mapping: ShellMapping, preparation: InputPreparation): void {
  if (JSON.stringify(preparation) !== JSON.stringify(prepare(message, mapping, preparation.confirmedSends)))
    throw new AgentError('shell input preparation identity mismatch')
}

export const completionPath = (mapping: ShellMapping): string => join(dirname(mapping.statePath), 'output.json')
export const submissionPath = (mapping: ShellMapping): string =>
  join(dirname(mapping.statePath), 'shell-submission.json')

export async function loadCompletion(mapping: ShellMapping): Promise<ShellCompletion> {
  const record = Schema.decodeUnknownSync(Completion)(await readJson(completionPath(mapping), 192 * 1024))
  if (JSON.stringify(record.mapping) !== JSON.stringify(mapping))
    throw new AgentError('shell completion identity mismatch')
  const result = record.result
  const bytes = Buffer.from(result.output, result.encoding ?? 'utf8')
  if (
    (result.encoding === 'base64' && bytes.toString('base64') !== result.output) ||
    bytes.length !== Math.min(result.total_bytes, outputBytes) ||
    result.truncated !== result.total_bytes > outputBytes
  )
    throw new AgentError('shell completion output is invalid')
  return record
}

export async function persistCompletion(record: ShellCompletion): Promise<void> {
  Schema.decodeUnknownSync(Completion)(record)
  await writePrivateFileAtomic(completionPath(record.mapping), JSON.stringify(record))
}

export function completionFor(
  mapping: ShellMapping,
  message: AgentMessage,
  preparation: InputPreparation,
  result: CommandOutput,
  stopped: boolean,
): ShellCompletion {
  return {
    version: 1,
    mapping,
    messageId: message.id,
    preparationId: preparation.preparationId,
    executionId: preparation.preparationId,
    completionKind: stopped ? 'stopped' : 'exited',
    processTreeStopped: true,
    result,
  }
}
