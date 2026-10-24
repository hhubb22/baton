import childProcess from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const pidFile = process.argv[2]
if (!pidFile) throw new Error('Missing pid file')

const grandchild = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
})
if (!grandchild.pid) throw new Error('Grandchild has no PID')
await writeFile(pidFile, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }))
setInterval(() => {}, 1000)
