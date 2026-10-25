import { it } from '@effect/vitest'
import { DEFAULT_SERVER_SETTINGS } from '@t3tools/contracts'
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost'
import { Effect, Exit, Option } from 'effect'
import { expect } from 'vite-plus/test'
import { join } from 'node:path'
import { agentHostLayer } from './host-layer.ts'
import type { ProcessRegistrar } from './process-registrar.ts'

const registrar: ProcessRegistrar = {
  register: () => Effect.succeed(false),
  release: () => Effect.void,
  close: Effect.void,
}

const paths = {
  workingDirectory: '/workspace/thread',
  privateDirectory: '/private/thread',
}

it.effect('points the upstream host at the Thread workspace and its private directory', () =>
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost
    expect(host.paths).toEqual({
      cwd: '/workspace/thread',
      baseDir: '/private/thread',
      stateDir: '/private/thread',
      providerStatusCacheDir: join(paths.privateDirectory, 'cache'),
      attachmentsDir: join(paths.privateDirectory, 'attachments'),
    })
    expect(yield* host.settings.get).toEqual(DEFAULT_SERVER_SETTINGS)
    expect(yield* host.settings.withSnapshot(Effect.succeed)).toEqual(DEFAULT_SERVER_SETTINGS)
    expect(yield* host.shouldRunBackgroundWork({ type: 'server-config' })).toBe(false)
    expect(host.resolveAttachmentPath({ id: 'attachment' } as never)).toBeNull()
  }).pipe(Effect.provide(agentHostLayer({ paths, registrar }))),
)

it.effect('exposes read-only credentials and refuses writes', () =>
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost
    const credentials = yield* host.credentials('cursor', 'cursor-default')
    expect(credentials.binding).toEqual({ owner: 't3', key: 'cursor:cursor-default' })
    expect(Option.isNone(yield* credentials.get)).toBe(true)
    const set = yield* credentials.set(new Uint8Array([1])).pipe(Effect.exit)
    const remove = yield* credentials.remove.pipe(Effect.exit)
    expect(Exit.isFailure(set) && set.cause.reasons.length > 0).toBe(true)
    expect(Exit.isFailure(remove)).toBe(true)
  }).pipe(Effect.provide(agentHostLayer({ paths, registrar }))),
)
