import { parseArgs } from 'node:util'
import { Effect } from 'effect'
import { telemetryLayer } from '@baton/telemetry'
import { defaultDataDirectory, isMissing, loadIdentity, registerNode } from './identity.ts'
import { initializeBrowseRoots } from './roots.ts'
import { runDaemon } from './daemon.ts'

export async function runDaemonCLI(action: 'up' | 'register' | 'run', args: string[]): Promise<void> {
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
          workspace: { type: 'string' },
        },
      })
    } catch {
      throw new Error('节点命令参数无效；注册凭据仅支持环境变量或私有文件')
    }
  })()
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const dataDirectory = values['data-dir']!
    await initializeBrowseRoots(dataDirectory, values.workspace)
    let identity
    if (action !== 'register') {
      try {
        identity = await loadIdentity(dataDirectory)
      } catch (error) {
        if (!isMissing(error) || action === 'run') throw error
      }
    }
    if (!identity) {
      if (!values.coordinator) throw new Error('首次注册需要 --coordinator https://中心地址')
      identity = await registerNode({
        dataDirectory,
        coordinatorURL: values.coordinator,
        signal: controller.signal,
        ...(values['enrollment-file'] ? { enrollmentFile: values['enrollment-file'] } : {}),
        ...(values['display-name'] ? { displayName: values['display-name'] } : {}),
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
    }
    if (action === 'register') return
    await Effect.runPromise(
      Effect.scoped(
        runDaemon({
          dataDirectory,
          identity,
          ...(values.relay ? { relayURL: values.relay } : {}),
          ...(values['ca-file'] ? { caFile: values['ca-file'] } : {}),
        }),
      ).pipe(Effect.provide(telemetryLayer('batond'))),
      { signal: controller.signal },
    )
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
