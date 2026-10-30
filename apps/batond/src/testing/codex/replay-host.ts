import { realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Effect, Layer } from 'effect'
import * as CodexReplay from 'effect-codex-app-server/replay'
import { layerCodexReplayClientFactory } from '@t3tools/provider-codex/testing'
import { materialized, readCodexTranscript } from './transcripts.ts'
export { readCodexTranscript } from './transcripts.ts'
import { runAgentHost, type AgentHostModule } from '../../agent-host/host.ts'
import { codexHostDriver } from '../../agents/codex/host-driver.ts'

/** Real Codex adapter with the upstream app-server replay client. */
export const codexReplayModule = (transcript: CodexReplay.CodexAppServerReplayTranscript): AgentHostModule => ({
  foldDetached: false,
  driver: ({ agentType, paths }) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const cwd = yield* Effect.promise(() => realpath(paths.workingDirectory))
        return codexHostDriver({ agentType, paths }).pipe(
          Layer.provide(
            layerCodexReplayClientFactory({
              transcript: materialized(transcript, cwd),
            }),
          ),
        )
      }),
    ),
})

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { transcript: { type: 'string' }, cwd: { type: 'string' }, state: { type: 'string' } },
})
if (values.transcript && values.cwd && values.state) {
  if ((await realpath(process.cwd())) !== (await realpath(values.cwd)))
    throw new Error('Codex host process cwd does not match its workspace')
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
