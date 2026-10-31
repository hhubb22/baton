import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Predicate, Schema } from 'effect'
import { ProviderReplayEntry, ProviderReplayTranscriptHeader } from '@t3tools/contracts'
import { AcpReplayTranscript } from '@t3tools/provider-acp-registry/testing/replay'

export type Transcript = AcpReplayTranscript

type Entry = Transcript['entries'][number]

export const kiroFixturePath = (name: string) =>
  fileURLToPath(
    new URL(
      `../../../../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/${name}.ndjson`,
      import.meta.url,
    ),
  )

export const readKiroTranscript = async (path: string): Promise<Transcript> => {
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  const { type: _type, ...header } = Schema.decodeUnknownSync(ProviderReplayTranscriptHeader)(
    JSON.parse(lines[0] ?? 'null'),
  )
  return Schema.decodeUnknownSync(AcpReplayTranscript)({
    ...header,
    entries: lines.slice(1).map((line): unknown => JSON.parse(line)),
  })
}

export const writeKiroTranscript = async (path: string, transcript: Transcript): Promise<void> => {
  const { entries, ...header } = transcript
  await writeFile(
    path,
    `${[JSON.stringify({ type: 'transcript_start', ...header }), ...entries.map((entry) => JSON.stringify(entry))].join('\n')}\n`,
  )
}

export const frameMethod = (entry: Entry) =>
  entry.type !== 'runtime_exit' && Predicate.hasProperty(entry.frame, 'method') ? entry.frame.method : undefined

/** Each recorded ACP process is replayed by an independent Baton host. */
export const segment = (transcript: Transcript, index: number): Transcript => {
  const grouped: Entry[][] = [[]]
  for (const entry of transcript.entries) {
    grouped.at(-1)?.push(entry)
    if (entry.type === 'runtime_exit') grouped.push([])
  }
  const entries = grouped[index]
  if (!entries?.length) throw new Error(`Kiro transcript has no segment ${index}`)
  return { ...transcript, scenario: `${transcript.scenario}-${index}`, entries }
}

/** The CLI recordings end on pipe close; the adapter explicitly closes its session. */
export const withSessionClose = (transcript: Transcript): Transcript => ({
  ...transcript,
  entries: [
    ...transcript.entries.filter((entry) => entry.type !== 'runtime_exit'),
    {
      type: 'expect_outbound',
      label: 'session.close',
      frame: { kind: 'request', method: 'session/close', params: { sessionId: 'native-session-1' } },
    },
    {
      type: 'emit_inbound',
      label: 'session.closed',
      frame: { kind: 'response', method: 'session/close', result: {} },
    },
    { type: 'runtime_exit', status: 'success' },
  ],
})

export const firstTurnOnly = (transcript: Transcript) => segment(transcript, 0)
export const resumedOnly = (transcript: Transcript) => segment(transcript, 1)

/** The saved Baton identity has disappeared from the recorded session listing. */
export const missingOnly = (transcript: Transcript): Transcript => {
  const restored = segment(transcript, 1)
  return {
    ...restored,
    scenario: `${transcript.scenario}-saved-session-missing`,
    metadata: {
      ...transcript.metadata,
      derivedFrom: transcript.scenario,
      purpose: 'Baton persisted session absent from the native listing',
    },
    entries: restored.entries.map((entry) => {
      if (
        entry.type !== 'emit_inbound' ||
        frameMethod(entry) !== 'session/list' ||
        !Predicate.hasProperty(entry.frame, 'result') ||
        !Predicate.hasProperty(entry.frame.result, 'sessions')
      )
        return entry
      const result = entry.frame.result
      const sessions = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(result.sessions)
      return {
        ...entry,
        frame: {
          ...entry.frame,
          result: {
            ...result,
            sessions: sessions.filter(
              (session) => !Predicate.hasProperty(session, 'sessionId') || session.sessionId !== 'native-session-1',
            ),
          },
        },
      }
    }),
  }
}

const effortLevelOption = {
  type: 'select',
  id: 'effortLevel',
  name: 'Effort',
  category: 'thought_level',
  currentValue: 'high',
  options: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, name: value })),
}

/** Derived from a Kiro 2.32.0 session: switching the model replaces its options, and only GPT models offer effort. */
const modelSwitches = (configOptions: readonly unknown[]): Transcript['entries'] => {
  const modelOption = configOptions.find((option) => Predicate.hasProperty(option, 'id') && option.id === 'model')
  const models = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ value: Schema.String })))(
    Predicate.hasProperty(modelOption, 'options') ? modelOption.options : [],
  )
  return models.flatMap(({ value }): Transcript['entries'] => [
    {
      type: 'expect_outbound',
      label: `session.set_model.${value}`,
      frame: {
        kind: 'request',
        method: 'session/set_config_option',
        params: { sessionId: 'native-session-1', configId: 'model', value },
      },
    },
    {
      type: 'emit_inbound',
      label: `session.model_set.${value}`,
      frame: {
        kind: 'response',
        method: 'session/set_config_option',
        result: {
          configOptions: [...configOptions, ...(value.startsWith('gpt-') ? [effortLevelOption] : [])].map((option) =>
            option === modelOption && Predicate.isObject(option) ? { ...option, currentValue: value } : option,
          ),
        },
      },
    },
  ])
}

/** Discovery opens an empty default-model session, reads each model's options and sends no prompt. */
export const probeOnly = (transcript: Transcript): Transcript => {
  const first = segment(transcript, 0)
  const prompt = first.entries.findIndex(
    (entry) => entry.type === 'expect_outbound' && frameMethod(entry) === 'session/prompt',
  )
  if (prompt < 0) throw new Error('Kiro transcript has no prompt')
  return {
    ...first,
    scenario: `${transcript.scenario}-probe`,
    metadata: {
      ...transcript.metadata,
      derivedFrom: transcript.scenario,
      purpose: 'Baton discovery without prompting',
    },
    entries: [
      ...first.entries.slice(0, prompt).map((entry) => {
        if (
          entry.type !== 'expect_outbound' ||
          frameMethod(entry) !== 'session/new' ||
          !Predicate.hasProperty(entry.frame, 'params') ||
          !Predicate.isObject(entry.frame.params)
        )
          return entry
        const { _meta, ...params } = entry.frame.params
        return { ...entry, frame: { ...entry.frame, params } }
      }),
      ...first.entries
        .slice(0, prompt)
        .flatMap((entry) =>
          entry.type === 'emit_inbound' &&
          frameMethod(entry) === 'session/new' &&
          Predicate.hasProperty(entry.frame, 'result') &&
          Predicate.hasProperty(entry.frame.result, 'configOptions')
            ? modelSwitches(Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(entry.frame.result.configOptions))
            : [],
        ),
      { type: 'runtime_exit', status: 'success' },
    ],
  }
}

/** Derived provider_error response isolates authentication failure after successful session creation. */
export const authenticationFailure = (transcript: Transcript): Transcript => {
  const first = segment(transcript, 0)
  const prompt = first.entries.findIndex(
    (entry) => entry.type === 'expect_outbound' && frameMethod(entry) === 'session/prompt',
  )
  if (prompt < 0) throw new Error('Kiro transcript has no prompt')
  return {
    ...first,
    scenario: `${transcript.scenario}-authentication-required`,
    metadata: {
      ...transcript.metadata,
      derivedFrom: transcript.scenario,
      purpose: 'Baton authentication failure reaches the durable Thread report without upstream diagnostics',
    },
    entries: [
      ...first.entries.slice(0, prompt + 1),
      {
        type: 'emit_inbound',
        label: 'response:session/prompt:authentication-required',
        frame: {
          kind: 'response',
          method: 'session/prompt',
          error: { code: -32000, message: 'Authentication required: private-auth-diagnostic' },
        },
      },
      { type: 'runtime_exit', status: 'success' },
    ],
  }
}

/** Replay provider_error followed by simple's reply in the same native session. */
export const failedThenCompleted = (failure: Transcript, success: Transcript): Transcript => {
  const failed = segment(failure, 0)
  const completed = segment(success, 0)
  const prompt = completed.entries.findIndex(
    (entry) => entry.type === 'expect_outbound' && frameMethod(entry) === 'session/prompt',
  )
  if (prompt < 0) throw new Error('Kiro success transcript has no prompt')
  const continuation = completed.entries
    .slice(prompt)
    .map((entry) =>
      Schema.decodeUnknownSync(ProviderReplayEntry)(
        JSON.parse(
          JSON.stringify(entry).replace(/message-(\d+)/gu, (_match, id: string) => `message-${Number(id) + 100}`),
        ),
      ),
    )
  return {
    ...failed,
    scenario: `${failure.scenario}-then-completed`,
    metadata: {
      ...failed.metadata,
      derivedFrom: [failure.scenario, success.scenario],
      purpose: 'Baton failed reply followed by a completed reply without restarting the native session',
    },
    entries: [...failed.entries.filter((entry) => entry.type !== 'runtime_exit'), ...continuation],
  }
}

/** Reuse simple's completed turn twice, with distinct native message identities. */
export const twoTurns = (transcript: Transcript): Transcript => {
  const first = segment(transcript, 0)
  const prompt = first.entries.findIndex(
    (entry) => entry.type === 'expect_outbound' && frameMethod(entry) === 'session/prompt',
  )
  if (prompt < 0) throw new Error('Kiro transcript has no prompt')
  const continuation = first.entries
    .slice(prompt)
    .map((entry) =>
      Schema.decodeUnknownSync(ProviderReplayEntry)(
        JSON.parse(
          JSON.stringify(entry).replace(/message-(\d+)/gu, (_match, id: string) => `message-${Number(id) + 100}`),
        ),
      ),
    )
  return {
    ...first,
    scenario: `${transcript.scenario}-two-turns`,
    metadata: { ...transcript.metadata, derivedFrom: transcript.scenario, purpose: 'Baton sequential turn mapping' },
    entries: [...first.entries.filter((entry) => entry.type !== 'runtime_exit'), ...continuation],
  }
}

/** Restore history only. The converted fixture wildcard is bound to the tested input. */
export const sentOnly = (transcript: Transcript, text: string): Transcript => {
  const restored = segment(transcript, 1)
  const prompt = restored.entries.findIndex(
    (entry) => entry.type === 'expect_outbound' && frameMethod(entry) === 'session/prompt',
  )
  return withSessionClose({
    ...restored,
    scenario: `${transcript.scenario}-sent`,
    metadata: { ...transcript.metadata, derivedFrom: transcript.scenario, purpose: 'Baton read-only sent evidence' },
    entries: (prompt < 0 ? restored.entries : restored.entries.slice(0, prompt)).map((entry) => {
      if (entry.type !== 'emit_inbound' || !Predicate.hasProperty(entry.frame, 'params')) return entry
      const params = entry.frame.params
      if (!Predicate.hasProperty(params, 'update')) return entry
      const update = params.update
      if (
        !Predicate.hasProperty(update, 'sessionUpdate') ||
        update.sessionUpdate !== 'user_message_chunk' ||
        !Predicate.hasProperty(update, 'content') ||
        !Predicate.hasProperty(update.content, 'text') ||
        update.content.text !== '<any>'
      )
        return entry
      return {
        ...entry,
        frame: {
          ...entry.frame,
          params: { ...params, update: { ...update, content: { ...update.content, text } } },
        },
      }
    }),
  })
}
