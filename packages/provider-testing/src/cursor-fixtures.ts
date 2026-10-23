import { readFile } from 'node:fs/promises'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { CursorAgentSdkReplayTranscript, CursorReplayTranscriptDecodeError } from './cursor.ts'

export const readCursorAgentSdkReplayTranscript = (path: string | URL) =>
  Effect.tryPromise({
    try: async () => {
      const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim())
      const header = Schema.decodeUnknownSync(
        Schema.Struct({
          type: Schema.Literal('transcript_start'),
          provider: Schema.Literal('cursor'),
          protocol: Schema.Literal('cursor-agent-sdk.local'),
          version: Schema.String,
          scenario: Schema.String,
          metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      )(JSON.parse(lines.shift() ?? 'null'))
      return Schema.decodeUnknownSync(CursorAgentSdkReplayTranscript)({
        ...header,
        entries: lines.map((line) => JSON.parse(line)),
      })
    },
    catch: (cause) => new CursorReplayTranscriptDecodeError({ cause }),
  })
