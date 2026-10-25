import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { connectAgentHost, type AgentHostProcessOptions } from '../../agent-host/transport.ts'
import { protectPrivateDirectory } from '../../platform/private.ts'

/** Read-only probe in an empty temporary workspace. It never sends a prompt. */
export const probeCodex = (
  options: Omit<AgentHostProcessOptions, 'agentType' | 'paths' | 'command'> & {
    command: AgentHostProcessOptions['command']
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'baton-codex-probe-workspace-')))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(temporary, { recursive: true, force: true })))
      yield* Effect.promise(() => protectPrivateDirectory(temporary))
      const controller = new AbortController()
      const host = yield* connectAgentHost(
        { ...options, agentType: 'codex', paths: { workingDirectory: temporary, privateDirectory: temporary } },
        controller.signal,
      )
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          controller.abort()
          yield* host.disconnect
          yield* host.reap.pipe(Effect.ignore)
        }),
      )
      return yield* host.probe
    }),
  )
