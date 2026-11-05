import { parseArgs } from 'node:util'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { Effect, Option } from 'effect'
import { telemetryEnvironment, telemetryLayer } from '@baton/telemetry'
import { defaultDataDirectory, isMissing, loadIdentity } from './identity.ts'
import { initializeBrowseRoots } from '../devices/roots.ts'
import { runDaemon } from './daemon.ts'
import { startTelemetryRelay } from './telemetry-relay.ts'

export async function runDaemonCLI(
  action: 'run' | 'serve' | 'identity',
  args: string[],
  dependencies: { stdin?: Readable } = {},
): Promise<void> {
  const { values } = (() => {
    try {
      return parseArgs({
        args,
        options: {
          'data-dir': { type: 'string', default: defaultDataDirectory() },
          relay: { type: 'string' },
          'control-timeout-seconds': { type: 'string' },
          workspace: { type: 'string' },
          ...(['run', 'serve'].includes(action) ? { 'exit-with-stdin': { type: 'boolean' as const } } : {}),
        },
      })
    } catch {
      throw new Error('节点命令参数无效')
    }
  })()
  const controlTimeoutSeconds = Number(values['control-timeout-seconds'] ?? 370)
  if (!Number.isInteger(controlTimeoutSeconds) || controlTimeoutSeconds < 1 || controlTimeoutSeconds > 3600)
    throw new Error('--control-timeout-seconds 需要 1～3600 秒的整数')
  const dataDirectory = values['data-dir']!
  if (action === 'identity') {
    try {
      const identity = await loadIdentity(dataDirectory)
      console.log(
        JSON.stringify({
          registered: true,
          employee_id: identity.employee_id,
          coordinator_url: identity.coordinator_url,
          node_id: identity.node_id,
          display_name: identity.display_name,
          system: identity.system,
        }),
      )
    } catch (error) {
      if (!isMissing(error)) throw error
      console.log(JSON.stringify({ registered: false }))
    }
    return
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  const parent =
    process.env.BATON_ENV_PARENT_PIPE === '1' ? createReadStream('', { fd: 3, autoClose: true }) : undefined
  delete process.env.BATON_ENV_PARENT_PIPE
  parent?.once('end', stop)
  parent?.once('error', stop)
  parent?.resume()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const stdin = dependencies.stdin ?? process.stdin
  if (values['exit-with-stdin']) {
    stdin.once('end', stop)
    stdin.resume()
    if (stdin.readableEnded) stop()
  }
  try {
    await initializeBrowseRoots(dataDirectory, values.workspace)
    let identity: Awaited<ReturnType<typeof loadIdentity>> | undefined
    try {
      identity = await loadIdentity(dataDirectory)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const localEndpoint = Object.keys(process.env).some((key) => key.startsWith('OTEL_EXPORTER_OTLP_'))
          const relay = localEndpoint
            ? Option.none()
            : yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: startTelemetryRelay,
                  catch: () => new Error('Telemetry relay unavailable'),
                }).pipe(Effect.option),
                (value) => (Option.isSome(value) ? Effect.promise(() => value.value.close()) : Effect.void),
              )
          const local = Option.getOrUndefined(relay)
          return yield* runDaemon({
            dataDirectory,
            ...(identity ? { identity } : {}),
            ...(local ? { telemetryRelay: local } : {}),
            controlTimeoutSeconds,
            ...(values.relay ? { relayURL: values.relay } : {}),
          }).pipe(
            Effect.provide(
              telemetryLayer('batond', {
                ...process.env,
                ...telemetryEnvironment(local),
                BATON_TELEMETRY_NODE_ID: identity?.node_id,
              }),
            ),
          )
        }),
      ),
      { signal: controller.signal },
    )
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    parent?.destroy()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (values['exit-with-stdin']) {
      stdin.removeListener('end', stop)
      stdin.pause()
    }
  }
}
