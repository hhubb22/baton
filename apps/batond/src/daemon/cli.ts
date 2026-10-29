import { parseArgs } from 'node:util'
import type { Readable } from 'node:stream'
import { Effect } from 'effect'
import { telemetryLayer } from '@baton/telemetry'
import { defaultDataDirectory, isMissing, loadIdentity, reauthNode, registerNode } from './identity.ts'
import { initializeBrowseRoots } from '../devices/roots.ts'
import { runDaemon } from './daemon.ts'
import { loadDeployment } from './deployment.ts'

export async function runDaemonCLI(
  action: 'up' | 'register' | 'reauth' | 'run' | 'identity',
  args: string[],
  dependencies: { installationDirectory?: string; stdin?: Readable } = {},
): Promise<void> {
  const { values } = (() => {
    try {
      return parseArgs({
        args,
        options: {
          'data-dir': { type: 'string', default: defaultDataDirectory() },
          coordinator: { type: 'string' },
          relay: { type: 'string' },
          'enrollment-file': { type: 'string' },
          'display-name': { type: 'string' },
          'ca-file': { type: 'string' },
          'control-timeout-seconds': { type: 'string' },
          workspace: { type: 'string' },
          ...(action === 'run' ? { 'exit-with-stdin': { type: 'boolean' as const } } : {}),
        },
      })
    } catch {
      throw new Error('节点命令参数无效；注册凭据仅支持环境变量或私有文件')
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
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const stdin = dependencies.stdin ?? process.stdin
  if (values['exit-with-stdin']) {
    stdin.once('end', stop)
    stdin.resume()
    if (stdin.readableEnded) stop()
  }
  try {
    if (action === 'reauth') {
      const identity = await reauthNode({
        dataDirectory,
        signal: controller.signal,
        ...(values['enrollment-file'] ? { enrollmentFile: values['enrollment-file'] } : {}),
        ...(values['ca-file'] ? { caFile: values['ca-file'] } : {}),
      })
      console.log(
        JSON.stringify({
          node_id: identity.node_id,
          employee_id: identity.employee_id,
          display_name: identity.display_name,
          system: identity.system,
        }),
      )
      return
    }
    await initializeBrowseRoots(dataDirectory, values.workspace)
    let identity
    try {
      identity = await loadIdentity(dataDirectory)
    } catch (error) {
      if (!isMissing(error) || action === 'run') throw error
    }
    if (identity && action === 'register') throw new Error('节点身份已存在，请直接运行 up 或 run')
    if (!identity) {
      const deployment = await loadDeployment(dependencies.installationDirectory)
      const coordinator = values.coordinator ?? deployment?.coordinator_url
      if (!coordinator) throw new Error('首次注册需要 --coordinator https://中心地址')
      identity = await registerNode({
        dataDirectory,
        coordinatorURL: coordinator,
        signal: controller.signal,
        ...(values['enrollment-file'] ? { enrollmentFile: values['enrollment-file'] } : {}),
        ...(values['display-name'] ? { displayName: values['display-name'] } : {}),
        ...(values['ca-file']
          ? { caFile: values['ca-file'] }
          : deployment?.ca_pem !== undefined
            ? { caPem: deployment.ca_pem }
            : {}),
      })
      console.log(
        JSON.stringify({
          node_id: identity.node_id,
          employee_id: identity.employee_id,
          display_name: identity.display_name,
          system: identity.system,
        }),
      )
    }
    if (action === 'register') return
    await Effect.runPromise(
      Effect.scoped(
        runDaemon({
          dataDirectory,
          identity,
          controlTimeoutSeconds,
          ...(values.relay ? { relayURL: values.relay } : {}),
          ...(values['ca-file'] ? { caFile: values['ca-file'] } : {}),
        }),
      ).pipe(Effect.provide(telemetryLayer('batond', { ...process.env, BATON_TELEMETRY_NODE_ID: identity.node_id }))),
      { signal: controller.signal },
    )
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (values['exit-with-stdin']) {
      stdin.removeListener('end', stop)
      stdin.pause()
    }
  }
}
