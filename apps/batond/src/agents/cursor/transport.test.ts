import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect, Fiber, Stream } from 'effect'
import { expect, it } from 'vite-plus/test'
import { startProcessWatchdog } from '../../platform/process.ts'
import { connectCursorHost } from './transport.ts'
import { prepare } from './evidence.ts'
import type { WorkerOpenConfig } from '@baton/protocol'

it('keeps the real stdio event RPC open across open, independent history and send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-cursor-rpc-'))
  const outfile = join(directory, 'peer.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/rpc-peer.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: 'import { createRequire as fixtureCreateRequire } from "node:module"; const require = fixtureCreateRequire(import.meta.url);',
    },
    external: ['@cursor/sdk', '@cursor/sdk/*'],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(outfile).href) },
  })
  const command = { file: process.execPath, args: [outfile] }
  const watchdog = await startProcessWatchdog({ ...command, args: [...command.args, 'watchdog'] })
  const config: WorkerOpenConfig = {
    thread_id: '00000000-0000-4000-8000-000000000001',
    node_id: '00000000-0000-4000-8000-000000000002',
    storage_generation: 'generation',
    agent_type: 'cursor',
    working_directory: directory,
    execution_timeout_seconds: 60,
    adapter_config: { state_path: join(directory, 'native.json') },
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* connectCursorHost({ command, watchdog }, new AbortController().signal)
          yield* Effect.addFinalizer(() =>
            live.disconnect.pipe(Effect.andThen(live.reap), Effect.ignore, Effect.asVoid),
          )
          const native = yield* live.open(config, 'generation')
          const events = yield* Stream.runCollect(live.events.pipe(Stream.take(3))).pipe(Effect.forkScoped)
          const reader = yield* connectCursorHost({ command, watchdog }, new AbortController().signal)
          const history = yield* reader.history(native)
          yield* reader.disconnect
          expect((yield* reader.reap).processTreeStopped).toBe(true)
          const input = { id: 'input', text: 'hello', epoch: 1, operationId: 'op', mode: 'queue' as const }
          expect(yield* live.send(input, prepare(input, native, history))).toEqual({
            nativeSessionId: 'native',
            executionId: 'run',
          })
          yield* live.abort
          const output = yield* Fiber.join(events)
          expect(output.at(-1)?.event).toMatchObject({ type: 'end', outcome: 'cancelled' })
          expect(output.map((event) => event.event.type)).toEqual(['delta', 'reply', 'end'])
          expect(output.map((event) => event.sequence)).toEqual([1, 2, 3])
        }),
      ),
    )
  } finally {
    await watchdog.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
