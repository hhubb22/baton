import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { initializeWorkerDirectory, LocalWorkerHost } from './host.ts'
import { runWorker } from './worker-runner.ts'

const loaded = vi.hoisted(() => new Set<string>())
vi.mock('../agents/cursor/sdk-loader.ts', () => {
  loaded.add('cursor/sdk-loader')
  throw new Error('Cursor SDK must not load in a Worker')
})
vi.mock('../agents/cursor/host-driver.ts', () => {
  loaded.add('cursor/host-driver')
  throw new Error('Cursor driver must not load in a Worker')
})
vi.mock('../agents/codex/host-driver.ts', () => {
  loaded.add('codex/host-driver')
  throw new Error('Codex driver must not load in a Worker')
})
vi.mock('../agents/pi/host-driver.ts', () => {
  loaded.add('pi/host-driver')
  throw new Error('Pi driver must not load in a Worker')
})
vi.mock('../agents/kiro/host-driver.ts', () => {
  loaded.add('kiro/host-driver')
  throw new Error('Kiro driver must not load in a Worker')
})

it('becomes ready over authenticated IPC without loading the Cursor SDK or host drivers', async () => {
  const directory = await makePrivateTempDirectory('bw-')
  const threadId = randomUUID()
  const previousUmask = process.umask()
  try {
    const paths = await initializeWorkerDirectory(directory, threadId)
    await writePrivateFileAtomic(paths.token, 'a'.repeat(64))
    const host = new LocalWorkerHost(directory)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkIn(
            runWorker({
              dataDirectory: directory,
              threadId,
              command: {
                executable: process.execPath,
                args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url))],
              },
            }),
            yield* Effect.scope,
          )
          yield* Effect.promise(() =>
            vi.waitFor(
              async () => {
                expect(await host.request(threadId, { type: 'status', ok: false })).toMatchObject({
                  ok: true,
                  worker_ready: true,
                  agent_ready: false,
                })
              },
              { timeout: 5000 },
            ),
          )
          expect([...loaded]).toEqual([])
        }),
      ),
    )
  } finally {
    process.umask(previousUmask)
    await rm(directory, { recursive: true, force: true })
  }
})
