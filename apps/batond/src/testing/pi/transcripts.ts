import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Effect, Predicate, Schema } from 'effect'
import { decodePiRpcReplayTranscript, type PiRpcReplayTranscript } from '@t3tools/provider-pi/testing'

type Entry = PiRpcReplayTranscript['entries'][number]

const Header = Schema.Struct({
  type: Schema.Literal('transcript_start'),
  provider: Schema.String,
  protocol: Schema.String,
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const piFixturePath = (name: string) =>
  fileURLToPath(
    new URL(
      `../../../../../upstream/t3code/apps/server/src/orchestration-v2/testkit/fixtures/${name}/pi_transcript.ndjson`,
      import.meta.url,
    ),
  )

export const readPiTranscript = async (path: string): Promise<PiRpcReplayTranscript> => {
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  const header = Schema.decodeUnknownSync(Header)(JSON.parse(lines[0] ?? 'null'))
  return Effect.runPromise(
    decodePiRpcReplayTranscript({
      provider: header.provider,
      protocol: header.protocol,
      version: header.version,
      scenario: header.scenario,
      ...(header.metadata ? { metadata: header.metadata } : {}),
      entries: lines.slice(1).map((line) => {
        const parsed: unknown = JSON.parse(line)
        return parsed
      }),
    }),
  )
}

export const writePiTranscript = async (path: string, transcript: PiRpcReplayTranscript): Promise<void> => {
  const { entries, ...header } = transcript
  const lines = [
    JSON.stringify({ type: 'transcript_start', ...header }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ]
  await writeFile(path, `${lines.join('\n')}\n`)
}

const frameType = (entry: Entry) =>
  entry.type !== 'runtime_exit' && Predicate.hasProperty(entry.frame, 'type') ? entry.frame.type : undefined

const resumeIndex = (transcript: PiRpcReplayTranscript) => {
  const index = transcript.entries.findIndex(
    (entry, index) => index > 0 && entry.type === 'expect_outbound' && frameType(entry) === 'process_start',
  )
  if (index < 0) throw new Error('Pi resume transcript requires a second process_start')
  return index
}

/** First process from upstream provider_thread_resume, ending after its completed turn. */
export const firstTurnOnly = (transcript: PiRpcReplayTranscript): PiRpcReplayTranscript => ({
  ...transcript,
  entries: transcript.entries.slice(0, resumeIndex(transcript)),
})

/** The recorded resumed process becomes process 1 in an independent replay host. */
export const resumedOnly = (transcript: PiRpcReplayTranscript): PiRpcReplayTranscript => ({
  ...transcript,
  entries: transcript.entries
    .slice(resumeIndex(transcript))
    .map((entry) =>
      entry.type !== 'runtime_exit' && entry.label !== undefined
        ? { ...entry, label: entry.label.replace(/@p\d+$/u, '') }
        : entry,
    ),
})

/**
 * Derived from an upstream completed-turn recording: reuse its launch, model,
 * final state, entries and completed message_end frames. Add switch_session and get_messages
 * request/response pairs for a fresh read-only adapter session, without a prompt.
 */
export const sentOnly = (transcript: PiRpcReplayTranscript): PiRpcReplayTranscript => {
  const outbound = (type: string) => {
    const entry = transcript.entries.find((entry) => entry.type === 'expect_outbound' && frameType(entry) === type)
    if (entry === undefined) throw new Error(`Pi transcript requires ${type}`)
    return entry
  }
  const response = (command: string) => {
    const entry = transcript.entries.findLast(
      (entry) =>
        entry.type === 'emit_inbound' &&
        Predicate.hasProperty(entry.frame, 'command') &&
        entry.frame.command === command,
    )
    if (entry?.type !== 'emit_inbound' || !Predicate.hasProperty(entry.frame, 'id'))
      throw new Error(`Pi transcript requires response:${command}`)
    const request = outbound(command)
    if (request.type !== 'expect_outbound' || !Predicate.hasProperty(request.frame, 'id'))
      throw new Error(`Pi transcript requires a request id for ${command}`)
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: entry.label.replace(/@p\d+$/u, '') }),
      frame: { ...entry.frame, id: request.frame.id },
    }
  }
  const state = response('get_state')
  if (state.type !== 'emit_inbound' || !Predicate.hasProperty(state.frame, 'data'))
    throw new Error('Pi transcript has no final state')
  const data = state.frame.data
  if (!Predicate.hasProperty(data, 'sessionFile') || typeof data.sessionFile !== 'string')
    throw new Error('Pi transcript has no native session file')
  const messages = transcript.entries.flatMap((entry) => {
    if (
      entry.type !== 'emit_inbound' ||
      frameType(entry) !== 'message_end' ||
      !Predicate.hasProperty(entry.frame, 'message')
    )
      return []
    const message = entry.frame.message
    return Predicate.hasProperty(message, 'role') && (message.role === 'user' || message.role === 'assistant')
      ? [message]
      : []
  })
  if (messages.length === 0) throw new Error('Pi transcript has no completed history')
  const snapshotId = 't3-100'
  return {
    ...transcript,
    scenario: `${transcript.scenario}-sent`,
    metadata: { ...transcript.metadata, derivedFrom: transcript.scenario, purpose: 'read-only sent evidence' },
    entries: [
      outbound('process_start'),
      {
        type: 'expect_outbound',
        label: 'switch_session',
        frame: { type: 'switch_session', sessionPath: data.sessionFile, id: 't3-99' },
      },
      {
        type: 'emit_inbound',
        label: 'response:switch_session',
        frame: { type: 'response', command: 'switch_session', success: true, id: 't3-99', data: { cancelled: false } },
      },
      outbound('get_state'),
      state,
      outbound('get_available_models'),
      response('get_available_models'),
      outbound('get_entries'),
      response('get_entries'),
      { type: 'expect_outbound', label: 'get_messages', frame: { type: 'get_messages', id: snapshotId } },
      {
        type: 'emit_inbound',
        label: 'response:get_messages',
        frame: {
          type: 'response',
          command: 'get_messages',
          success: true,
          id: snapshotId,
          data: { messages },
        },
      },
    ],
  }
}

/**
 * Append upstream multi_turn's second turn after message_steering. Its incremental
 * get_entries cursor and first parent follow the steering recording's final leaf;
 * other frames retain their recorded payloads. The testkit rebinds request ids.
 */
export const withQueuedFollowUp = (
  steering: PiRpcReplayTranscript,
  multiTurn: PiRpcReplayTranscript,
): PiRpcReplayTranscript => {
  const prompts = multiTurn.entries.flatMap((entry, index) =>
    entry.type === 'expect_outbound' && frameType(entry) === 'prompt' ? [index] : [],
  )
  const second = prompts[1]
  if (second === undefined) throw new Error('Pi multi_turn transcript requires a second prompt')
  const entries = steering.entries.findLast(
    (entry) =>
      entry.type === 'emit_inbound' &&
      Predicate.hasProperty(entry.frame, 'command') &&
      entry.frame.command === 'get_entries',
  )
  if (entries?.type !== 'emit_inbound' || !Predicate.hasProperty(entries.frame, 'data'))
    throw new Error('Pi steering transcript requires final entries')
  const data = entries.frame.data
  if (!Predicate.hasProperty(data, 'leafId') || typeof data.leafId !== 'string')
    throw new Error('Pi steering transcript requires a final leaf')
  const continuation = multiTurn.entries.slice(second)
  const cursor = continuation.find((entry) => entry.type === 'expect_outbound' && frameType(entry) === 'get_entries')
  if (cursor?.type !== 'expect_outbound' || !Predicate.hasProperty(cursor.frame, 'since'))
    throw new Error('Pi multi_turn transcript requires an incremental entries cursor')
  const previousLeaf = cursor.frame.since
  return {
    ...steering,
    scenario: `${steering.scenario}-queued-follow-up`,
    metadata: { ...steering.metadata, derivedFrom: `${steering.scenario}, ${multiTurn.scenario}` },
    entries: [
      ...steering.entries,
      ...continuation.map((entry) => {
        if (entry.type === 'expect_outbound' && frameType(entry) === 'get_entries' && Predicate.isObject(entry.frame))
          return { ...entry, frame: { ...entry.frame, since: data.leafId } }
        if (
          entry.type !== 'emit_inbound' ||
          !Predicate.hasProperty(entry.frame, 'command') ||
          entry.frame.command !== 'get_entries' ||
          !Predicate.hasProperty(entry.frame, 'data') ||
          !Predicate.hasProperty(entry.frame.data, 'entries')
        )
          return entry
        const entries = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(entry.frame.data.entries)
        return {
          ...entry,
          frame: {
            ...entry.frame,
            data: {
              ...entry.frame.data,
              entries: entries.map((item) =>
                Predicate.hasProperty(item, 'parentId') && item.parentId === previousLeaf
                  ? { ...item, parentId: data.leafId }
                  : item,
              ),
            },
          },
        }
      }),
    ],
  }
}
