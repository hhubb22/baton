import { spawn } from 'node:child_process'
import { buildServer } from './build-server.mjs'

const bundle = await buildServer()
const child = spawn(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', () => {
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
