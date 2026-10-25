import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Effect } from 'effect'
import { runWorker } from '@baton/batond/daemon/worker-runner'
import { runWatchdogCommand } from '@baton/batond/platform/process'

async function main() {
  const entry = process.argv[1]
  if (!entry) throw new Error('Replay Worker requires its entry path')
  const command = process.argv[2]
  if (command === 'watchdog') {
    await runWatchdogCommand()
    return
  }
  if (command === 'agent-host') {
    const agentType = process.argv[3]
    if (agentType !== 'cursor' && agentType !== 'pi' && agentType !== 'codex' && agentType !== 'kiro')
      throw new Error('Unsupported replay Agent')
    const { values } = parseArgs({
      args: process.argv.slice(4),
      options: { cwd: { type: 'string' }, state: { type: 'string' } },
    })
    if (!values.cwd || !values.state) throw new Error('Missing replay host paths')
    const resumed = await access(join(values.state, 'native.json')).then(
      () => true,
      () => false,
    )
    const bundle = join(dirname(entry), `${agentType}-host.mjs`)
    const transcript = join(dirname(entry), `${agentType}-${resumed ? 'resumed' : 'first'}.ndjson`)
    process.argv = [process.execPath, bundle, '--transcript', transcript, '--cwd', values.cwd, '--state', values.state]
    await import(pathToFileURL(bundle).href)
    return
  }
  if (command !== 'worker') throw new Error('Unsupported replay command')
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { 'data-dir': { type: 'string' }, 'thread-id': { type: 'string' } },
  })
  const dataDirectory = values['data-dir']
  const threadId = values['thread-id']
  if (!dataDirectory || !threadId) throw new Error('Missing replay Worker identity')
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  await Effect.runPromise(
    Effect.scoped(
      runWorker({
        dataDirectory,
        threadId,
        command: { executable: process.execPath, args: [entry] },
      }),
    ),
    { signal: controller.signal },
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })
}

await main()
