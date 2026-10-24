import childProcess from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--grandchild') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  process.send?.('ready')
} else {
  const pidFile = process.argv[2]
  if (!pidFile) throw new Error('Missing Kiro ACP pid file')
  const grandchild = childProcess.fork(process.argv[1], ['--grandchild'], {
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  await new Promise((resolve, reject) => {
    grandchild.once('message', resolve)
    grandchild.once('error', reject)
    grandchild.once('exit', () => reject(new Error('Kiro ACP grandchild exited before readiness')))
  })
  if (!grandchild.pid) throw new Error('Kiro ACP grandchild has no PID')
  grandchild.disconnect()
  // EOF leaves both processes alive so host cleanup must reclaim the group.
  setInterval(() => {}, 1000)
  const methods = []
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    const request = JSON.parse(line)
    methods.push(request.method)
    await writeFile(pidFile, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, methods }))
    let result
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
        break
      case 'session/new':
        result = { sessionId: 'kiro-local-reclaim' }
        break
      default:
        if (request.id !== undefined) {
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported local ACP method' } })}\n`,
          )
        }
        continue
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
  }
}
