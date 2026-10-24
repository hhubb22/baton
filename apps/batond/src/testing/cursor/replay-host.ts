import { parseArgs } from 'node:util'
import { Effect } from 'effect'
import { Layer } from 'effect'
import type { CursorAgentSdkReplayTranscript } from '@t3tools/provider-cursor/testing'
import { layerCursorAgentSdkReplay } from '@t3tools/provider-cursor/testing'
import { runAgentHost, type AgentHostModule } from '../../agent-host/host.ts'
import { cursorHostDriver } from '../../agents/cursor/host-driver.ts'
import { readTranscript } from './transcripts.ts'

/**
 * Replay Agent host entry: the same cursor driver and RPC skeleton as the
 * production host, with the SDK runner replaced by a deterministic recording.
 * The transcript path arrives before the `agent-host` arguments the Worker adds.
 */
export const replayAgentHostModule = (transcript: CursorAgentSdkReplayTranscript): AgentHostModule => ({
  driver: ({ agentType }) =>
    cursorHostDriver({ agentType }).pipe(
      Layer.provide(layerCursorAgentSdkReplay(transcript, { assertCompleteOnFinalize: false })),
    ),
})

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { transcript: { type: 'string' }, cwd: { type: 'string' }, state: { type: 'string' } },
})
if (!values.transcript || !values.cwd || !values.state)
  throw new Error('Replay host needs --transcript, --cwd and --state')
const transcript = await readTranscript(values.transcript)
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
await Effect.runPromise(
  Effect.scoped(
    runAgentHost(replayAgentHostModule(transcript), {
      agentType: 'cursor',
      paths: { workingDirectory: values.cwd, privateDirectory: values.state },
    }),
  ),
  { signal: controller.signal },
).catch(() => {
  if (!controller.signal.aborted) process.exitCode = 1
})
