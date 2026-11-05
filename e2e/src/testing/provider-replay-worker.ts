import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
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
  throw new Error('Unsupported replay command')
}

await main()
