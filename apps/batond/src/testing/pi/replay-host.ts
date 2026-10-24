import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Effect, Predicate, Schema } from 'effect'
import {
  decodePiRpcReplayTranscript,
  layerPiReplaySpawner,
  type PiRpcReplayTranscript,
} from '@t3tools/provider-pi/testing'
import { runAgentHost, type AgentHostModule } from '../../agent-host/host.ts'
import { piHostDriver } from '../../agents/pi/host-driver.ts'

const Header = Schema.Struct({
  type: Schema.Literal('transcript_start'),
  provider: Schema.String,
  protocol: Schema.String,
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

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

const sessionTitle = (transcript: PiRpcReplayTranscript) => {
  for (const entry of transcript.entries) {
    if (entry.type !== 'expect_outbound') continue
    if (!Predicate.hasProperty(entry.frame, 'type') || !Predicate.hasProperty(entry.frame, 'name')) continue
    if (entry.frame.type === 'set_session_name' && typeof entry.frame.name === 'string') return entry.frame.name
  }
  return undefined
}

/** Real Pi adapter with the upstream RPC replay spawner in place of the `pi` process. */
export const piReplayModule = (transcript: PiRpcReplayTranscript): AgentHostModule => ({
  foldDetached: false,
  spawner: layerPiReplaySpawner(transcript),
  driver: ({ agentType }) => {
    const title = sessionTitle(transcript)
    return piHostDriver({
      agentType,
      launchArgs: typeof transcript.metadata?.launchArgs === 'string' ? transcript.metadata.launchArgs : '',
      ...(title === undefined ? {} : { sessionTitle: title }),
    })
  },
})

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { transcript: { type: 'string' }, cwd: { type: 'string' }, state: { type: 'string' } },
})
if (values.transcript && values.cwd && values.state) {
  const transcript = await readPiTranscript(values.transcript)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  await Effect.runPromise(
    Effect.scoped(
      runAgentHost(piReplayModule(transcript), {
        agentType: 'pi',
        paths: { workingDirectory: values.cwd, privateDirectory: values.state },
      }),
    ),
    { signal: controller.signal },
  ).catch(() => {
    if (!controller.signal.aborted) process.exitCode = 1
  })
}
