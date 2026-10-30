import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Effect } from 'effect'
import { WebSocketServer } from 'ws'
import type { NodeIdentity, RuntimeAgent } from '@baton/protocol'
import { telemetryEnvironment, telemetryLayer } from '@baton/telemetry'
import { initializeBrowseRoots } from '../devices/roots.ts'
import { runDaemon, type RunDaemonOptions } from '../daemon/daemon.ts'
import { connectWebSocket } from '../daemon/transport.ts'
import { makePrivateTempDirectory } from './private.ts'

const capability: RuntimeAgent = {
  agent_type: 'cursor',
  version: 'offline',
  status: 'available',
  models: [],
  default_model: 'default',
  runtime_modes: [{ id: 'full-access', available: true }],
  default_runtime_mode: 'full-access',
  capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
}
export async function setupDaemon(cleanup: Array<() => Promise<unknown>>) {
  const path = await makePrivateTempDirectory('bd-')
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  await initializeBrowseRoots(path, path)
  const id: NodeIdentity = {
    node_id: randomUUID(),
    employee_id: randomUUID(),
    display_name: 'Offline',
    system: 'macos',
    role: '',
    capabilities: [],
    registration_seq: 1,
    registered_at: new Date().toISOString(),
    credential: {
      id: randomUUID(),
      token: 'offline-server-issued-token',
      version: 1,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    coordinator_url: 'https://offline.invalid',
  }
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing local address')
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate()
        wss.close(() => resolve())
      }),
  )
  const transport: NonNullable<RunDaemonOptions['transport']> = (_url, options) =>
    connectWebSocket(`ws://127.0.0.1:${address.port}`, options)
  const start = (options: Partial<RunDaemonOptions> = {}) => {
    const controller = new AbortController()
    let failure: unknown
    const program = Effect.scoped(
      runDaemon({
        dataDirectory: path,
        identity: id,
        transport,
        heartbeatMs: 100,
        pollIntervalMs: 20,
        probe: async () => capability,
        ...options,
      }),
    )
    const running = Effect.runPromise(
      options.telemetryRelay
        ? program.pipe(
            Effect.provide(
              telemetryLayer('batond', {
                OTEL_BSP_SCHEDULE_DELAY: '30',
                OTEL_BLRP_SCHEDULE_DELAY: '30',
                OTEL_METRIC_EXPORT_INTERVAL: '300',
                ...telemetryEnvironment(options.telemetryRelay),
              }),
            ),
          )
        : program,
      { signal: controller.signal },
    ).catch((error: unknown) => {
      if (!controller.signal.aborted) failure = error
    })
    const stop = async () => {
      controller.abort()
      await running
    }
    cleanup.push(stop)
    return { stop, running, failure: () => failure }
  }
  return { path, id, wss, start }
}
