import { spawn } from 'node:child_process'

export function runBundle(bundle, args = process.argv.slice(2)) {
  const child = spawn(process.execPath, [bundle, ...args], { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.once('error', () => {
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
  return child
}
