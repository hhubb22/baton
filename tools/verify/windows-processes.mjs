import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { environment, isolatedEnv } from '../lib/installation.mjs'

const self = fileURLToPath(import.meta.url)
const [role, recordFile, orphan] = process.argv.slice(2)
if (role === '--leaf') {
  process.send({ leaf: process.pid })
  setInterval(() => {}, 1000)
} else if (role === '--branch') {
  const leaf = spawn(process.execPath, [self, '--leaf'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  leaf.once('message', ({ leaf: leafPid }) => {
    process.send({ branch: process.pid, leaf: leafPid }, () => {
      if (orphan === 'yes') process.exit(0)
    })
  })
  setInterval(() => {}, 1000)
} else if (role === '--root') {
  const branch = spawn(process.execPath, [self, '--branch', recordFile, orphan], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  branch.once('message', (pids) => writeFileSync(recordFile, JSON.stringify({ root: process.pid, ...pids })))
  setInterval(() => {}, 1000)
} else if (process.platform !== 'win32') {
  console.log(
    JSON.stringify(
      { ...environment(), status: 'not-measured', reason: 'Windows is required; no process was terminated.' },
      null,
      2,
    ),
  )
} else {
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const taskkill = join(process.env.SystemRoot, 'System32/taskkill.exe')
  const directory = mkdtempSync(join(tmpdir(), 'baton-win-tree-'))
  const registered = []
  function creationTime(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid PID')
    const source = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }`
    const output = execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15_000, env: isolatedEnv(directory) },
    ).trim()
    if (output && !/^\d+$/.test(output)) throw new Error('Unexpected CIM creation time')
    return output || null
  }
  function guardedKill(entry) {
    const current = creationTime(entry.pid)
    if (!current || current !== entry.createdAtTicks)
      return { killed: false, current, reason: current ? 'creation-time-mismatch' : 'already-exited' }
    // CIM check followed by taskkill has a TOCTOU interval; this is not a Job Object guarantee.
    execFileSync(taskkill, ['/PID', String(entry.pid), '/T', '/F'], {
      stdio: 'pipe',
      timeout: 15_000,
      env: isolatedEnv(directory),
    })
    return { killed: true, current }
  }
  async function waitFor(check, description) {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await delay(100)
    }
    throw new Error(`Timed out: ${description}`)
  }
  async function tree(name, exitBranch) {
    const file = join(directory, `${name}.json`)
    const child = spawn(process.execPath, [self, '--root', file, exitBranch ? 'yes' : 'no'], {
      stdio: 'ignore',
      env: isolatedEnv(directory),
    })
    child.on('error', (error) => {
      throw error
    })
    const rootTime = await waitFor(() => creationTime(child.pid), 'root registration')
    registered.push({ pid: child.pid, createdAtTicks: rootTime })
    const pids = await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')), 'three-level tree')
    const leafTime = creationTime(pids.leaf)
    if (!leafTime) throw new Error('Grandchild missing before taskkill')
    registered.push({ pid: pids.leaf, createdAtTicks: leafTime })
    const branchTime = creationTime(pids.branch)
    if (branchTime) registered.push({ pid: pids.branch, createdAtTicks: branchTime })
    if (exitBranch) await waitFor(() => !creationTime(pids.branch), 'intermediate parent exit')
    const killed = guardedKill({ pid: pids.root, createdAtTicks: rootTime })
    await delay(500)
    const survivors = Object.fromEntries(Object.entries(pids).map(([key, pid]) => [key, creationTime(pid)]))
    return { pids, killed, survivors }
  }
  try {
    const normal = await tree('normal', false)
    if (!normal.killed.killed || Object.values(normal.survivors).some(Boolean))
      throw new Error('taskkill /T /F left a member of the intact tree alive')
    const unrelated = spawn(process.execPath, [self, '--leaf'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: isolatedEnv(directory),
    })
    unrelated.on('error', (error) => {
      throw error
    })
    const createdAtTicks = await waitFor(() => creationTime(unrelated.pid), 'unrelated process')
    registered.push({ pid: unrelated.pid, createdAtTicks })
    const stale = guardedKill({ pid: unrelated.pid, createdAtTicks: (BigInt(createdAtTicks) - 10_000n).toString() })
    if (stale.killed || creationTime(unrelated.pid) !== createdAtTicks)
      throw new Error('Stale ledger entry killed an unrelated process')
    const exitedIntermediate = await tree('orphan', true)
    console.log(
      JSON.stringify(
        {
          ...environment(),
          status: 'measured',
          normal,
          staleLedgerGuard: stale,
          actualOsPidReuse:
            'not forced; a live unrelated process was checked against a deliberately stale creation time',
          exitedIntermediate,
          orphanGapObserved: Boolean(exitedIntermediate.survivors.leaf),
          limitations: [
            'CIM and taskkill are not atomic; PID reuse between the check and termination remains possible.',
            'This script does not measure the delay from Worker crash to its next restart.',
          ],
        },
        null,
        2,
      ),
    )
  } finally {
    for (const entry of registered.reverse()) {
      try {
        guardedKill(entry)
      } catch (error) {
        console.error(`Cleanup failed for owned PID ${entry.pid}: ${error.message}`)
        process.exitCode = 1
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
}
