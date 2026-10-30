import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Predicate, Schema } from 'effect'
import * as CodexReplay from 'effect-codex-app-server/replay'
import { materializeReplayTranscriptWorkspace } from '../../../../../upstream/t3code/packages/provider-testing/src/replayTranscript.ts'

export type Transcript = CodexReplay.CodexAppServerReplayTranscript

export const codexFixturePath = (scenario: string) =>
  fileURLToPath(
    new URL(
      `../../../../../upstream/t3code/apps/server/src/orchestration-v2/testkit/fixtures/${scenario}/codex_transcript.ndjson`,
      import.meta.url,
    ),
  )

export const writeCodexTranscript = async (path: string, transcript: Transcript): Promise<void> => {
  const { entries, ...header } = transcript
  await writeFile(
    path,
    [JSON.stringify({ type: 'transcript_start', ...header }), ...entries.map((entry) => JSON.stringify(entry))].join(
      '\n',
    ) + '\n',
  )
}

const Header = Schema.Struct({
  type: Schema.Literal('transcript_start'),
  provider: Schema.String,
  protocol: Schema.String,
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const readCodexTranscript = async (path: string): Promise<Transcript> => {
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  const header = Schema.decodeUnknownSync(Header)(JSON.parse(lines[0] ?? 'null'))
  return Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)({
    ...header,
    entries: lines.slice(1).map((line) => {
      const parsed: unknown = JSON.parse(line)
      return parsed
    }),
  })
}

/** Derive turn policy from the recorded transcript for the selected replay mode. */
export const withReplayMode = (transcript: Transcript, mode: 'full-access' | 'approval-required'): Transcript => ({
  ...transcript,
  metadata: { ...transcript.metadata, derivedPolicy: mode },
  entries: transcript.entries.map((entry) => {
    if (entry.type !== 'expect_outbound' || !Predicate.isObject(entry.frame)) return entry
    const frame = entry.frame
    if (frame.method !== 'turn/start' || !Predicate.isObject(frame.params)) return entry
    return {
      ...entry,
      frame: {
        ...frame,
        params: {
          ...frame.params,
          approvalPolicy: mode === 'full-access' ? 'never' : 'untrusted',
          sandboxPolicy: { type: mode === 'full-access' ? 'dangerFullAccess' : 'readOnly' },
        },
      },
    }
  }),
})

export const materialized = (transcript: Transcript, cwd: string): Transcript =>
  Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)(
    materializeReplayTranscriptWorkspace(transcript, cwd),
  )

export const firstTurnOnly = (transcript: Transcript): Transcript => {
  const exit = transcript.entries.findIndex((entry) => entry.type === 'runtime_exit')
  if (exit === -1) throw new Error('Codex transcript has no first runtime exit')
  return { ...transcript, entries: transcript.entries.slice(0, exit + 1) }
}

export const resumedOnly = (transcript: Transcript): Transcript => {
  const exit = transcript.entries.findIndex((entry) => entry.type === 'runtime_exit')
  if (exit === -1 || exit === transcript.entries.length - 1) throw new Error('Codex transcript has no resumed runtime')
  return { ...transcript, entries: transcript.entries.slice(exit + 1) }
}

/**
 * Command permission comes from tool_call_read_only_on_request; the question is
 * from plan_questions. MCP form fields mirror upstream CodexMcpElicitation.test.ts.
 * Outbound responses require accept once and the explicit answer to the question.
 */
export const withRuntimeQuestions = (permission: Transcript, questions?: Transcript, accept = false): Transcript => {
  const approval = permission.entries.find(
    (entry) => entry.type === 'emit_inbound' && entry.label === 'item/commandExecution/requestApproval',
  )
  const question = questions?.entries.find(
    (entry) => entry.type === 'emit_inbound' && entry.label === 'item/tool/requestUserInput',
  )
  const responseIndex = permission.entries.findIndex(
    (entry) => entry.type === 'expect_outbound' && entry.label === 'item/commandExecution/requestApproval',
  )
  if (!approval || approval.type !== 'emit_inbound' || responseIndex === -1)
    throw new Error('Codex transcript lacks a command permission')
  const identity = Schema.decodeUnknownSync(
    Schema.Struct({ params: Schema.Struct({ threadId: Schema.String, turnId: Schema.String }) }),
  )(approval.frame).params
  const questionParams =
    question?.type === 'emit_inbound'
      ? Schema.decodeUnknownSync(Schema.Struct({ params: Schema.Record(Schema.String, Schema.Unknown) }))(
          question.frame,
        ).params
      : undefined
  if (questions && !questionParams) throw new Error('Codex transcript lacks a user question')
  const injected: Transcript['entries'] = questionParams
    ? [
        {
          type: 'emit_inbound',
          label: 'item/tool/requestUserInput',
          frame: { id: 101, method: 'item/tool/requestUserInput', params: { ...questionParams, ...identity } },
        },
        {
          type: 'expect_outbound',
          label: 'question answered',
          frame: { id: 101, result: { answers: accept ? { schema_preference: { answers: ['UI flexibility'] } } : {} } },
        },
      ]
    : [
        {
          type: 'emit_inbound',
          label: 'mcpServer/elicitation/request',
          frame: {
            id: 100,
            method: 'mcpServer/elicitation/request',
            params: {
              ...identity,
              mode: 'form',
              message: 'Allow ChatGPT to use Safari?',
              serverName: 'computer-use',
              _meta: { app_name: 'Safari', persist: ['session', 'always'] },
              requestedSchema: {
                type: 'object',
                properties: { approval: { type: 'string', enum: ['once', 'session', 'always'] } },
                required: ['approval'],
              },
            },
          },
        },
        {
          type: 'expect_outbound',
          label: 'mcp answered',
          frame: {
            id: 100,
            result: accept ? { action: 'accept', content: { approval: 'once' } } : { action: 'cancel' },
          },
        },
      ]
  return {
    ...permission,
    scenario: `${permission.scenario}-runtime-questions`,
    entries: [
      ...permission.entries.slice(0, responseIndex + 1),
      ...injected,
      ...permission.entries.slice(responseIndex + 1),
    ],
  }
}

/** Derive a read-only thread/read exchange from the recorded completed turn. */
export const sentOnly = (transcript: Transcript): Transcript => {
  const start = transcript.entries.find((entry) => entry.type === 'expect_outbound' && entry.label === 'thread/start')
  const created = transcript.entries.find((entry) => entry.type === 'emit_inbound' && entry.label === 'thread/start')
  const completed = transcript.entries.find(
    (entry) => entry.type === 'emit_inbound' && entry.label === 'turn/completed',
  )
  if (!start || !created || created.type !== 'emit_inbound' || !completed || completed.type !== 'emit_inbound')
    throw new Error('Codex transcript lacks a completed thread')
  const response = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ thread: Schema.Record(Schema.String, Schema.Unknown) }) }),
  )(created.frame)
  const thread = response.result.thread
  const turn = Schema.decodeUnknownSync(
    Schema.Struct({ params: Schema.Struct({ turn: Schema.Record(Schema.String, Schema.Unknown) }) }),
  )(completed.frame).params.turn
  const users = transcript.entries.flatMap((entry) => {
    if (entry.type !== 'emit_inbound' || entry.label !== 'item/completed' || !Predicate.isObject(entry.frame)) return []
    const params = entry.frame.params
    if (!Predicate.isObject(params) || !Predicate.isObject(params.item) || params.item.type !== 'userMessage') return []
    return [params.item]
  })
  const items = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(turn.items)
  const initialization = transcript.entries.slice(0, transcript.entries.indexOf(start))
  return {
    ...transcript,
    scenario: `${transcript.scenario}-sent`,
    entries: [
      ...initialization,
      {
        type: 'expect_outbound',
        label: 'thread/read',
        frame: { id: 2, method: 'thread/read', params: { threadId: thread.id, includeTurns: true } },
      },
      {
        type: 'emit_inbound',
        label: 'thread/read',
        frame: { id: 2, result: { thread: { ...thread, turns: [{ ...turn, items: [...users, ...items] }] } } },
      },
      { type: 'runtime_exit', status: 'success' },
    ],
  }
}
