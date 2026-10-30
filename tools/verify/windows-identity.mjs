import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProcessIdentity } from '../../apps/batond/src/platform/identity.ts'
import { isolatedEnv } from '../lib/installation.mjs'

if (process.platform !== 'win32') throw new Error('Windows required')
if (process.argv[2] === '--isolated') {
  const first = await readProcessIdentity(process.pid)
  const second = await readProcessIdentity(process.pid)
  const child = spawn(process.execPath, ['-e', ''])
  const pid = child.pid
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  const exited = await readProcessIdentity(pid)
  let protectedProcess
  try {
    protectedProcess = (await readProcessIdentity(4)) ? 'accessible' : 'absent'
  } catch {
    protectedProcess = 'inspection-error'
  }
  const stable = !!first && first.creationTime === second?.creationTime
  console.log(JSON.stringify({ stable, exitedIsNull: exited === null, protectedProcess }))
  if (!stable || exited !== null) process.exitCode = 1
} else {
  const home = await mkdtemp(join(tmpdir(), 'baton-identity-'))
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], {
      env: isolatedEnv(home),
      stdio: 'inherit',
      windowsHide: true,
    })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0) process.exitCode = 1
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
