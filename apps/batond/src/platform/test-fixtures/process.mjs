import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { acquireProcessLock } from '../lock.ts'
import { spawnOwnedProcess, spawnDetachedWorker, startProcessWatchdog, runWatchdogCommand } from '../process.ts'
import { installHostProcessGroup } from '../host-process-group.ts'

const self = fileURLToPath(import.meta.url)
const [role, path] = process.argv.slice(2)
const keepAlive = () => setInterval(() => {}, 1000)
if (role === 'watchdog') {
  await runWatchdogCommand()
} else if (role === 'leaf') {
  console.log(JSON.stringify({ leaf: process.pid }))
  keepAlive()
} else if (role === 'tree' || role === 'controlled-tree' || role === 'controlled-orphan-tree') {
  if (role !== 'tree') installHostProcessGroup()
  const orphan = role === 'controlled-orphan-tree'
  const child = spawn(process.execPath, [self, orphan ? 'orphan-branch' : 'branch'], {
    detached: role !== 'tree',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  createInterface({ input: child.stdout }).once('line', (line) => {
    console.log(JSON.stringify({ root: process.pid, ...JSON.parse(line) }))
    if (orphan) process.exit(0)
  })
  keepAlive()
} else if (role === 'branch' || role === 'orphan-branch') {
  const child = spawn(process.execPath, [self, 'leaf'], { stdio: ['ignore', 'pipe', 'inherit'] })
  createInterface({ input: child.stdout }).once('line', (line) => {
    console.log(JSON.stringify({ branch: process.pid, ...JSON.parse(line) }))
    if (role === 'orphan-branch') process.exit(0)
  })
  keepAlive()
} else if (role === 'worker-controlled-tree') {
  const watchdog = await startProcessWatchdog({ file: process.execPath, args: [self, 'watchdog'] })
  const owned = await spawnOwnedProcess({ file: process.execPath, args: [self, 'controlled-tree'] }, { watchdog })
  createInterface({ input: owned.stdout }).once('line', (line) =>
    console.log(JSON.stringify({ ...JSON.parse(line), watchdog: watchdog.pid })),
  )
  keepAlive()
} else if (role === 'lock') {
  await acquireProcessLock(path)
  console.log('locked')
  keepAlive()
} else if (role === 'launcher') {
  const worker = await spawnDetachedWorker({ file: process.execPath, args: [self, 'detached-worker'] })
  console.log(JSON.stringify({ worker }))
} else if (role === 'detached-worker') {
  console.log(JSON.stringify({ worker: process.pid }))
  keepAlive()
} else {
  throw new Error(`Unknown fixture role: ${role}`)
}
