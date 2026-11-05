import { runWatchdogCommand } from '../platform/process.ts'

async function main() {
  if (process.argv[2] === 'watchdog') {
    await runWatchdogCommand()
    return
  }
  throw new Error('Unsupported replay command')
}
void main()
