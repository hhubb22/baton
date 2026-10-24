import { parseArgs } from 'node:util'
import { Effect } from 'effect'
import { telemetryLayer } from '@baton/telemetry'

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'up' || action === 'register' || action === 'run') {
    const { runDaemonCLI } = await import('./daemon/cli.ts')
    await runDaemonCLI(action, args)
    return
  }
  if (action === 'files' || action === 'project-exec') {
    const { runDeviceCLI } = await import('./devices/cli.ts')
    await runDeviceCLI(action, args)
    return
  }
  if (action === 'login' || action === 'subscriptions') {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
    if ((action === 'login' && positionals.length !== 1) || (action === 'subscriptions' && positionals.length !== 0))
      throw new Error('用法：login <openai-codex|xai> 或 subscriptions')
    const { runProjectCLI } = await import('./project/index.ts')
    await runProjectCLI(action, positionals[0])
    return
  }
  if (action === 'watchdog') {
    const { runWatchdogCommand } = await import('./platform/process.ts')
    await runWatchdogCommand()
    return
  }
  if (action === 'worker' || action === 'agent-host') {
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      if (action === 'worker') {
        const { values } = parseArgs({
          args,
          options: { 'data-dir': { type: 'string' }, 'thread-id': { type: 'string' } },
        })
        if (!values['data-dir'] || !values['thread-id']) throw new Error('Worker needs --data-dir and --thread-id')
        const { runWorker } = await import('./daemon/worker-runner.ts')
        await Effect.runPromise(
          Effect.scoped(runWorker({ dataDirectory: values['data-dir'], threadId: values['thread-id'] })).pipe(
            Effect.provide(telemetryLayer('baton-worker')),
          ),
          { signal: controller.signal },
        )
      } else {
        const { values, positionals } = parseArgs({
          args,
          allowPositionals: true,
          options: { cwd: { type: 'string' }, state: { type: 'string' } },
        })
        const agentType = positionals[0]
        if (!agentType || !values.cwd || !values.state)
          throw new Error('Agent host needs an Agent type, --cwd and --state')
        const { runAgentHostCommand } = await import('./agent-host/index.ts')
        await Effect.runPromise(
          Effect.scoped(
            runAgentHostCommand(agentType, { workingDirectory: values.cwd, privateDirectory: values.state }),
          ),
          { signal: controller.signal },
        )
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    return
  }
  const { runLocalCLI } = await import('./cli.ts')
  await runLocalCLI(process.argv.slice(2))
}

void main().catch((error: unknown) => {
  const action = process.argv[2]
  // SDK diagnostics remain in the isolated host; public errors contain no raw SDK output.
  console.error(
    JSON.stringify({
      ok: false,
      code: 'batond_failed',
      message:
        action === 'worker' || action === 'agent-host' || action === 'watchdog'
          ? `${action} failed`
          : error instanceof Error
            ? error.message
            : 'Baton 本地命令失败',
    }),
  )
  process.exitCode = 1
})
