import { parseArgs } from 'node:util'
import { Effect } from 'effect'

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'watchdog') {
    const { runWatchdogCommand } = await import('./platform/process.ts')
    await runWatchdogCommand()
    return
  }
  if (action === 'worker' || action === 'cursor-host') {
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
          Effect.scoped(runWorker({ dataDirectory: values['data-dir'], threadId: values['thread-id'] })),
          { signal: controller.signal },
        )
      } else {
        const { runCursorHost } = await import('./agents/cursor/host.ts')
        await Effect.runPromise(Effect.scoped(runCursorHost()), { signal: controller.signal })
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
        action === 'worker' || action === 'cursor-host' || action === 'watchdog'
          ? `${action} failed`
          : error instanceof Error
            ? error.message
            : 'Baton 本地命令失败',
    }),
  )
  process.exitCode = 1
})
