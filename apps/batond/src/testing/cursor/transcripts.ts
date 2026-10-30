import { readFile } from 'node:fs/promises'
import { buildRuntimeInstructions } from '@t3tools/provider-core/server/runtimeInstructions'
import { Schema } from 'effect'
import {
  CursorAgentSdkReplayTranscript,
  type CursorAgentSdkReplayTranscript as Transcript,
} from '@t3tools/provider-cursor/testing'

const Header = Schema.Struct({
  type: Schema.Literal('transcript_start'),
  provider: Schema.Literal('cursor'),
  protocol: Schema.Literal('cursor-agent-sdk.local'),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const readTranscript = async (path: string): Promise<Transcript> => {
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  const header = Schema.decodeUnknownSync(Header)(JSON.parse(lines[0] ?? 'null'))
  return Schema.decodeUnknownSync(CursorAgentSdkReplayTranscript)({
    ...header,
    entries: lines.slice(1).map((line) => JSON.parse(line) as unknown),
  })
}

/**
 * `run.start` frames were recorded with raw prompts; the replay harness appends
 * the runtime instructions for the current harness and model.
 */
export const withRuntimeInstructions = (transcript: Transcript, model: string): Transcript => {
  const instructions = buildRuntimeInstructions({ harness: 'Cursor', model })
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== 'expect_outbound') return entry
      const frame = entry.frame as Record<string, unknown> | null
      if (!frame || frame.type !== 'run.start' || typeof frame.message !== 'string') return entry
      if (frame.message.endsWith(instructions)) return entry
      return { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } }
    }),
  }
}

/** A replay host that only proves one input reached the native session. */
export const sentOnly = (
  transcript: Transcript,
  agentId: string,
  userText: string,
  assistantText: string,
): Transcript => {
  const open = transcript.entries.find((entry) => {
    if (entry.type !== 'expect_outbound') return false
    return (entry.frame as Record<string, unknown> | null)?.type === 'agent.open'
  })
  if (!open || open.type !== 'expect_outbound') throw new Error('Transcript has no agent.open frame')
  return {
    ...transcript,
    scenario: `${transcript.scenario}-sent`,
    entries: [
      {
        type: 'expect_outbound',
        label: 'agent.resume',
        frame: { ...(open.frame as Record<string, unknown>), operation: 'resume', agentId },
      },
      { type: 'emit_inbound', label: 'agent.resumed', frame: { type: 'agent.opened', agentId } },
      {
        type: 'expect_outbound',
        label: 'agent.messages.list',
        frame: { type: 'agent.messages.list', agentId },
      },
      {
        type: 'emit_inbound',
        label: 'agent.messages',
        frame: {
          type: 'agent.messages',
          messages: [
            { uuid: 'sent-user', type: 'user', message: userText },
            { uuid: 'sent-assistant', type: 'assistant', message: assistantText },
          ],
        },
      },
      { type: 'expect_outbound', label: 'agent.close', frame: { type: 'agent.close', agentId } },
    ],
  }
}

/** The first turn only, so its host can stop after the recording's close frame. */
export const firstTurnOnly = (transcript: Transcript): Transcript => {
  const close = transcript.entries.findIndex((entry) => {
    if (entry.type !== 'expect_outbound') return false
    return (entry.frame as Record<string, unknown> | null)?.type === 'agent.close'
  })
  if (close === -1) throw new Error('Transcript has no agent.close frame')
  return { ...transcript, entries: transcript.entries.slice(0, close + 1) }
}

/** A resumed host replays only the frames after the first turn closed the native agent. */
export const resumedOnly = (transcript: Transcript): Transcript => {
  const index = transcript.entries.findIndex((entry) => {
    if (entry.type !== 'expect_outbound') return false
    const frame = entry.frame as Record<string, unknown> | null
    return frame?.type === 'agent.open' && frame.operation === 'resume'
  })
  if (index === -1) throw new Error('Transcript has no resumed agent frame')
  return { ...transcript, entries: transcript.entries.slice(index) }
}
