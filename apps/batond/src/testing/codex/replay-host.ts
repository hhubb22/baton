import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Effect, Layer, Schema } from 'effect'
import * as CodexReplay from 'effect-codex-app-server/replay'
import { layerCodexReplayClientFactory } from '@t3tools/provider-codex/testing'
import { runAgentHost, type AgentHostModule } from '../../agent-host/host.ts'
import { codexHostDriver } from '../../agents/codex/host-driver.ts'

const Header = Schema.Struct({
  type: Schema.Literal('transcript_start'),
  provider: Schema.String,
  protocol: Schema.String,
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const readCodexTranscript = async (path: string) => {
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim() !== '')
  const header = Schema.decodeUnknownSync(Header)(JSON.parse(lines[0] ?? 'null'))
  return Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)({
    provider: header.provider,
    protocol: header.protocol,
    version: header.version,
    scenario: header.scenario,
    ...(header.metadata ? { metadata: header.metadata } : {}),
    entries: lines.slice(1).map((line) => {
      const parsed: unknown = JSON.parse(line)
      return parsed
    }),
  })
}

/** Real Codex adapter with the upstream app-server replay client. */
export const codexReplayModule = (transcript: CodexReplay.CodexAppServerReplayTranscript): AgentHostModule => ({
  foldDetached: false,
  driver: ({ agentType, paths }) =>
    codexHostDriver({ agentType, paths }).pipe(Layer.provide(layerCodexReplayClientFactory({ transcript }))),
})

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { transcript: { type: 'string' }, cwd: { type: 'string' }, state: { type: 'string' } },
})
if (values.transcript && values.cwd && values.state) {
  const transcript = await readCodexTranscript(values.transcript)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  await Effect.runPromise(
    Effect.scoped(
      runAgentHost(codexReplayModule(transcript), {
        agentType: 'codex',
        paths: { workingDirectory: values.cwd, privateDirectory: values.state },
      }),
    ),
    { signal: controller.signal },
  ).catch(() => {
    if (!controller.signal.aborted) process.exitCode = 1
  })
}
