import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Effect, Layer } from 'effect'
import { layerAcpReplaySpawner } from '@t3tools/provider-acp-registry/testing/replay'
import { AcpRegistryCatalog } from '@t3tools/provider-acp-registry/server/AcpRegistrySupport'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import { runAgentHost, type AgentHostModule } from '../../agent-host/host.ts'
import { droidHostDriver } from '../../agents/droid/host-driver.ts'
import { runWatchdogCommand } from '../../platform/process.ts'
import { readKiroTranscript, type Transcript } from '../kiro/transcripts.ts'

/** The real Droid driver and ACP stack use a local replay spawner. */
const droidReplayModule = (transcript: Transcript, statusPath: string): AgentHostModule => ({
  foldDetached: false,
  spawner: layerAcpReplaySpawner(transcript, {
    statusPath,
    scriptPath: fileURLToPath(new URL('./droid-replay-agent.mjs', import.meta.url)),
  }),
  driver: (input) =>
    droidHostDriver({ ...input, versionProbe: Effect.succeed({ state: 'ready', version: '1.1.0' }) }).pipe(
      Layer.provide(
        Layer.mock(AcpRegistryCatalog)({
          inspect: () =>
            Effect.succeed({ status: 'ready', agentId: 'factory-droid', version: null, distribution: 'local' }),
          resolve: (_settings, cwd) =>
            Effect.succeed({
              distribution: 'local',
              spawn: { command: 'droid', args: ['exec', '--output-format', 'acp'], cwd, env: {}, shell: false },
            }),
        }),
      ),
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
      runAgentHost(droidReplayModule(transcript, `${values.transcript}.status.json`), {
        agentType: 'droid',
        paths: { workingDirectory: values.cwd, privateDirectory: values.state },
      }),
    ),
    { signal: controller.signal },
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })
}
