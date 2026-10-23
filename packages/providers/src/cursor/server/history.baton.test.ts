import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { vi } from 'vitest'
import { makeBatonCursorAgentSdkRunner, ThreadId, ProviderSessionId, inspectCursorSdk } from '../index.ts'
import { Agent, SqliteLocalAgentStore } from './sdk.ts'
import { layer } from './sdk-runtime.ts'

it.effect('reads detached history from a reopened explicit SQLite store without opening an agent', () =>
  Effect.gen(function* () {
    assert.equal(inspectCursorSdk().version, '1.0.35')
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'baton-cursor-store-')))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(dir, { recursive: true, force: true })))
    const options = { workspaceRef: dir, stateRoot: join(dir, 'private-store') }
    const first = yield* Effect.promise(() => SqliteLocalAgentStore.open(options))
    yield* Effect.promise(async () => {
      try {
        await first.agents.create({
          agent: { agentId: 'agent-detached-local', cwd: dir, status: 'idle', createdAt: 1, updatedAt: 1 },
        })
      } finally {
        await first.dispose()
      }
    })
    const store = yield* Effect.acquireRelease(
      Effect.promise(() => SqliteLocalAgentStore.open(options)),
      (value) => Effect.promise(() => value.dispose()),
    )
    using create = vi.spyOn(Agent, 'create')
    using resume = vi.spyOn(Agent, 'resume')
    using list = vi.spyOn(Agent.messages, 'list')
    const runner = yield* makeBatonCursorAgentSdkRunner()
    assert.deepStrictEqual(yield* runner.listMessages('agent-detached-local', { cwd: dir, store }), [])
    assert.equal(list.mock.calls[0]?.[1]?.store, store)
    assert.equal(create.mock.calls.length, 0)
    assert.equal(resume.mock.calls.length, 0)
    // A session and detached reader must route to the identical native store.
    create.mockRejectedValueOnce(new Error('offline create sentinel'))
    yield* runner
      .open({
        operation: 'create',
        options: { apiKey: 'explicit-offline-key', local: { cwd: dir, store } },
        threadId: ThreadId.make('store-test'),
        providerSessionId: ProviderSessionId.make('store-test'),
      })
      .pipe(Effect.flip)
    assert.equal(create.mock.calls[0]?.[0].local?.store, store)
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
