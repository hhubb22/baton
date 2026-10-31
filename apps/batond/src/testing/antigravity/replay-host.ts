import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Effect, Layer } from 'effect'
import { layerAcpReplaySpawner } from '@t3tools/provider-acp-registry/testing/replay'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import { runAgentHost, type AgentHostModule } from '../../agent-host/host.ts'
import { antigravityHostDriver } from '../../agents/antigravity/host-driver.ts'
import { runWatchdogCommand } from '../../platform/process.ts'
import { readKiroTranscript, type Transcript } from '../kiro/transcripts.ts'

/** The real Antigravity driver and ACP stack use a local replay spawner. */
const antigravityReplayModule = (transcript: Transcript, statusPath: string): AgentHostModule => ({
  foldDetached: false,
  spawner: layerAcpReplaySpawner(transcript, {
    statusPath,
    scriptPath: fileURLToPath(new URL('./antigravity-replay-agent.mjs', import.meta.url)),
  }),
  driver: (input) =>
    antigravityHostDriver({ ...input, versionProbe: Effect.succeed({ state: 'ready', version: '1.4.12' }) }).pipe(
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    ),
})

if (process.argv[2] === 'watchdog') await runWatchdogCommand()

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { transcript: { type: 'string' }, cwd: { type: 'string' }, state: { type: 'string' } },
})
if (values.transcript && values.cwd && values.state) {
  const transcript = await readKiroTranscript(values.transcript)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  await Effect.runPromise(
    Effect.scoped(
      runAgentHost(antigravityReplayModule(transcript, `${values.transcript}.status.json`), {
        agentType: 'antigravity',
        paths: { workingDirectory: values.cwd, privateDirectory: values.state },
      }),
    ),
    { signal: controller.signal },
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })
}
