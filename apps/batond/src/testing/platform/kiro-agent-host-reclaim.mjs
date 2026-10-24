import { parseArgs } from 'node:util'
import { Effect, Layer } from 'effect'
import { AcpRegistryCatalog } from '@t3tools/provider-acp-registry/server/AcpRegistrySupport'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import { runAgentHost } from '../../agent-host/host.ts'
import { kiroHostDriver } from '../../agents/kiro/host-driver.ts'
import { runWatchdogCommand } from '../../platform/watchdog.ts'

if (process.argv[2] === 'watchdog') {
  await runWatchdogCommand()
} else {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { stub: { type: 'string' }, cwd: { type: 'string' }, state: { type: 'string' } },
  })
  const { stub, cwd, state } = values
  if (!stub || !cwd || !state) throw new Error('Missing Kiro reclaim host paths')
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  await Effect.runPromise(
    Effect.scoped(
      runAgentHost(
        {
          foldDetached: false,
          driver: (input) =>
            kiroHostDriver(input).pipe(
              Layer.provide(
                Layer.mock(AcpRegistryCatalog)({
                  resolve: (_settings, workingDirectory) =>
                    Effect.succeed({
                      distribution: 'local',
                      spawn: {
                        command: process.execPath,
                        args: [stub, `${state}/kiro-pids.json`],
                        cwd: workingDirectory,
                        shell: false,
                      },
                    }),
                }),
              ),
              Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
            ),
        },
        { agentType: 'kiro', paths: { workingDirectory: cwd, privateDirectory: state } },
      ),
    ),
    { signal: controller.signal },
  ).catch((error) => {
    if (!controller.signal.aborted) throw error
  })
}
process.exit(0)
