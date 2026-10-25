import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { buildSea, environment, isolatedEnv } from './common.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const driverSource = String.raw`
import childProcess from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect } from 'effect'
import { LocalWorkerHost } from './apps/batond/src/daemon/host.ts'
import { workerPaths } from './apps/batond/src/daemon/paths.ts'
import { readProcessLock, processLockIsHeld } from './apps/batond/src/platform/lock.ts'
import { requestWorker } from './apps/batond/src/daemon/ipc.ts'
import { readProcessIdentity, identityMatches, systemCommand, windowsTool } from './apps/batond/src/platform/identity.ts'
import { makeWorker } from './apps/batond/src/worker/index.ts'
import { isolatedEnv, stats } from './tools/ts-migration/common.mjs'

async function main() {
const [root, executable, sampleArgument, transactionArgument] = process.argv.slice(2)
const samples = Number(sampleArgument)
const ledgerTransactions = Number(transactionArgument)
const spawn = childProcess.spawn
let currentSample
// The real Host supplies argv, detached state, log handles, ownership and readiness logic.
// Only environment isolation and monotonic observation are supplied by this harness.
childProcess.spawn = (file, args, options) => {
  if (file !== executable || args[0] !== 'worker') return spawn(file, args, options)
  if (!currentSample || currentSample.child) throw new Error('Unexpected duplicate Worker spawn')
  currentSample.spawnedAt = performance.now()
  const child = spawn(file, args, { ...options, cwd: currentSample.home, env: isolatedEnv(currentSample.home) })
  currentSample.child = child
  currentSample.exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  void currentSample.exit.catch(() => {})
  return child
}

async function within(promise, timeoutMs, description) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
async function waitGone(identity, description) {
  const deadline = performance.now() + 5000
  while (await identityMatches(identity)) {
    if (performance.now() >= deadline) throw new Error(description)
    await delay(10)
  }
}
async function findWatchdog(workerPid) {
  // Windows Workers do not create a watchdog.
  if (process.platform === 'win32') return undefined
  const output = await systemCommand('/bin/ps', ['-axo', 'pid=,ppid=,args='])
  const children = output.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match && Number(match[2]) === workerPid)
  const matches = children.filter((match) => match[3].endsWith(' watchdog') && match[3].includes(executable))
  if (matches.length !== 1) throw new Error('Expected exactly one real SEA watchdog child: ' + JSON.stringify(children.map((match) => match[3])))
  const identity = await readProcessIdentity(Number(matches[0][1]))
  if (!identity) throw new Error('Watchdog exited before readiness verification')
  return identity
}
async function finish(sample) {
  if (!sample.child) return
  const shutdownStarted = performance.now()
  const identity = sample.workerIdentity ?? await readProcessIdentity(sample.child.pid)
  if (process.platform === 'win32') {
    if (identity && await identityMatches(identity)) {
      await systemCommand(windowsTool('taskkill.exe'), ['/PID', String(identity.pid), '/T', '/F'])
    }
    await within(sample.exit, 5000, 'Worker did not exit after taskkill')
    if (identity) await waitGone(identity, 'Worker survived taskkill')
    if (await processLockIsHeld(sample.paths.lock)) throw new Error('Terminated Worker still owns a live lock')
    return performance.now() - shutdownStarted
  }
  let watchdogFailure
  sample.watchdogIdentity ??= identity ? await findWatchdog(identity.pid).catch((error) => { watchdogFailure = error }) : undefined
  if (identity && await identityMatches(identity)) process.kill(identity.pid, 'SIGTERM')
  try {
    const exit = await within(sample.exit, 5000, 'Worker did not exit after SIGTERM')
    if (exit.code !== 0 || exit.signal !== null) throw new Error('Worker did not shut down gracefully: ' + JSON.stringify(exit))
    if (sample.watchdogIdentity) await waitGone(sample.watchdogIdentity, 'Watchdog survived graceful Worker shutdown')
    if (identity) await waitGone(identity, 'Worker still executes after its exit event')
    if (watchdogFailure) throw watchdogFailure
    if (await readProcessLock(sample.paths.lock) !== null) throw new Error('Worker lock survived graceful shutdown')
    return performance.now() - shutdownStarted
  } catch (error) {
    if (identity && await identityMatches(identity)) process.kill(identity.pid, 'SIGKILL')
    await within(sample.exit.catch(() => {}), 5000, 'Worker did not exit after cleanup SIGKILL')
    if (sample.watchdogIdentity) await waitGone(sample.watchdogIdentity, 'Watchdog did not finish EOF cleanup')
    throw error
  }
}
function inspectLedger(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((row) => row.name)
    const expected = ['thread_commands', 'thread_messages', 'thread_meta', 'thread_outbox', 'thread_processes', 'worker_commit']
    if (JSON.stringify(tables) !== JSON.stringify(expected) || db.prepare('SELECT COUNT(*) AS n FROM worker_commit').get().n !== 1) throw new Error('Actual Worker migration was not persisted')
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error('Actual Worker did not persist WAL mode')
    return { tables, journalMode: 'wal' }
  } finally { db.close() }
}

const timings = []
const hostTimings = []
const shutdownTimings = []
let ledger
let failure
for (let index = 0; index < samples; index++) {
  const directory = join(root, 's' + index)
  const home = join(directory, 'home')
  await mkdir(directory, { mode: 0o700 })
  await mkdir(home, { mode: 0o700 })
  const dataDirectory = join(directory, 'data')
  const threadId = randomUUID()
  const paths = workerPaths(dataDirectory, threadId)
  const host = new LocalWorkerHost(dataDirectory, { executable, args: [] })
  const sample = { home, paths }
  currentSample = sample
  try {
    const started = performance.now()
    const status = await host.request(threadId, { type: 'status', ok: false }, { start: true, timeoutMs: 1000 })
    const statusAt = performance.now()
    if (!sample.child || !status.ok || status.worker_ready !== true || status.pid !== sample.child.pid || status.agent_ready === true) throw new Error('Invalid real authenticated Worker status')
    const elapsed = statusAt - sample.spawnedAt
    timings.push(elapsed)
    hostTimings.push(statusAt - started)
    sample.workerIdentity = await readProcessIdentity(status.pid)
    const owner = await readProcessLock(paths.lock)
    if (!sample.workerIdentity || !owner || owner.pid !== status.pid || owner.creationTime !== sample.workerIdentity.creationTime) throw new Error('Ready Worker did not own its process lock')
    sample.watchdogIdentity = await findWatchdog(status.pid)
    try {
      await requestWorker({ endpoint: paths.endpoint, token: '0'.repeat(64), request: { type: 'status', ok: false } })
      throw new Error('Worker accepted an invalid IPC token')
    } catch (error) {
      if (error.code !== 'unauthorized') throw error
    }
    if (elapsed >= 3000) throw new Error('Spawn-to-authenticated-status exceeded the unchanged 3 second budget')
  } catch (error) {
    failure = { sample: index, message: error.message, log: await readFile(paths.log, 'utf8').catch(() => '') }
  } finally {
    try { shutdownTimings.push(await finish(sample)) } catch (error) {
      failure ??= { sample: index, message: error.message, log: await readFile(paths.log, 'utf8').catch(() => '') }
    }
    currentSample = undefined
  }
  if (failure) break
  ledger = inspectLedger(paths.ledger)
  await rm(directory, { recursive: true })
  if ((index + 1) % 10 === 0) console.error('worker-startup: ' + (index + 1) + '/' + samples + ' ready and cleaned')
}
childProcess.spawn = spawn

async function measureLedger() {
  const path = join(root, 'queue.db')
  const commits = []
  const operations = []
  const originalPrepare = DatabaseSync.prototype.prepare
  let measuring = false
  let pragmas
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql)
    if (sql.trim().toUpperCase() === 'COMMIT') {
      if (!pragmas) {
        pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'fullfsync', 'wal_autocheckpoint'].map((name) => [name, Object.values(originalPrepare.call(this, 'PRAGMA ' + name).get())[0]]))
      }
      const run = statement.run
      statement.run = function (...args) {
        const started = performance.now()
        try { return run.apply(this, args) } finally { if (measuring) commits.push(performance.now() - started) }
      }
    }
    return statement
  }
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const worker = yield* makeWorker({
        dbPath: path,
        agentFactory: () => Effect.die(new Error('No Agent operation belongs to process-record queue measurement')),
      })
      const identity = yield* Effect.promise(() => readProcessIdentity(process.pid))
      const record = { ...identity, role: 'cursor-host' }
      const warmup = 200
      for (let index = 0; index < warmup + ledgerTransactions; index++) {
        if (index === warmup) {
          measuring = true
          histogram.enable()
          yield* Effect.promise(() => delay(10))
          histogram.reset()
        }
        const started = performance.now()
        yield* index % 2 === 0 ? worker.records.add(record) : worker.records.remove(record)
        if (measuring) operations.push(performance.now() - started)
      }
      yield* Effect.promise(() => delay(10))
      histogram.disable()
    })))
    if (pragmas.synchronous !== 2 || pragmas.journal_mode !== 'wal') throw new Error('Actual ledger was not WAL/FULL')
    if (commits.length !== ledgerTransactions) throw new Error('Expected exactly one actual COMMIT per measured queue operation')
    return {
      workload: 'Real makeWorker serial queue; alternating records.add/remove(cursor-host), actual ledger.save and commit token verification',
      warmupTransactions: 200,
      transactions: ledgerTransactions,
      pragmas,
      commit: stats(commits),
      queuedOperation: stats(operations),
      eventLoop: { resolutionMs: 1, p50Ms: histogram.percentile(50) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 },
      exceeds50Ms: stats(commits).p99Ms > 50,
      limitations: 'In-process real Worker/SQLite queue with no Agent or IPC; process-record workload is not a prompt/input-intent workload. Default fullfsync; no power-loss test.',
    }
  } finally { DatabaseSync.prototype.prepare = originalPrepare; histogram.disable() }
}
let fullLedger
let ledgerFailure
if (ledgerTransactions) {
  try { fullLedger = await measureLedger() }
  catch (error) { ledgerFailure = { message: error.message } }
}
const completed = timings.length === samples && shutdownTimings.length === samples
console.log(JSON.stringify({
  samplesRequested: samples,
  samplesCompleted: timings.length,
  firstSpawnToAuthenticatedStatusMs: timings[0],
  spawnToAuthenticatedStatus: stats(timings),
  hostEnsureAndStatus: stats(hostTimings),
  shutdownAndProcessCleanup: stats(shutdownTimings.filter(Number.isFinite)),
  cleanup: process.platform === 'win32'
    ? { mode: 'CIM identity check, taskkill /T /F, wait for exit and stale lock', watchdog: 'not provided by Windows Worker', graceful: false }
    : { mode: 'SIGTERM, wait for Worker and watchdog exit and lock release', watchdog: 'verified', graceful: true },
  readyStatus: timings.length ? { authenticated: true, workerReady: true, agentReady: false } : undefined,
  ledger,
  isolation: { childPath: '', temporaryHome: true, sourceFiles: false, installationFiles: await readdir(join(root, 'installed')) },
  budgetMs: 3000,
  passed: completed && !failure && !ledgerFailure && !fullLedger?.exceeds50Ms && Math.max(...timings) < 3000,
  cache: 'Fresh Worker processes and SQLite files; OS page cache is not flushed. First sample is reported separately. Agent registry and platform Worker watchdog behavior are included; no Thread is opened.',
  timing: 'Immediately before the real LocalWorkerHost spawn call through its final authenticated status response; includes Host readiness polling, launch-lock release and final status round trip. hostEnsureAndStatus additionally includes data-directory and token preparation.',
  fullLedger,
  ...(ledgerFailure ? { ledgerFailure } : {}),
  ...(failure ? { failure } : {}),
}, null, 2))
if (!completed || failure || ledgerFailure || Math.max(...timings) >= 3000 || fullLedger?.exceeds50Ms) process.exitCode = 1
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
`

export async function buildMeasurementDriver(output) {
  const { build } = await import('esbuild')
  await build({
    stdin: { contents: driverSource, resolveDir: repository, sourcefile: 'worker-startup-measurement.mjs' },
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    logLevel: 'silent',
  })
  return output
}

export function installedExecutable(installed) {
  return join(installed, process.platform === 'win32' ? 'batond.exe' : 'batond')
}

export async function withTemporaryInstallation(source, use) {
  // Short paths keep Darwin UDS endpoints below 103 bytes.
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bw-'))
  const installed = join(root, 'installed')
  try {
    if (source) {
      await cp(resolve(source), installed, { recursive: true, verbatimSymlinks: true })
      const base = await realpath(installed)
      async function checkLinks(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isSymbolicLink()) {
            const target = relative(base, await realpath(path))
            if (
              target === '..' ||
              target.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) ||
              isAbsolute(target)
            )
              throw new Error('Installation symlink points outside package: ' + path)
          } else if (entry.isDirectory()) await checkLinks(path)
        }
      }
      await checkLinks(installed)
    } else await mkdir(installed)
    return await use({ root, installed, executable: installedExecutable(installed) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function measureWorkerStartup({
  root,
  installed,
  samples = 100,
  ledgerTransactions = 0,
  preparedDirectory,
}) {
  const home = join(root, 'driver-home')
  await mkdir(home, { mode: 0o700 })
  const executable = installedExecutable(installed)
  const version = spawnSync(executable, ['--version'], {
    cwd: home,
    env: isolatedEnv(home),
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  })
  if (version.error) throw version.error
  if (version.status !== 0) throw new Error('Installed --version failed: ' + version.stderr)
  const runtime = JSON.parse(version.stdout)
  if (
    !runtime.sea ||
    runtime.platform !== process.platform ||
    runtime.arch !== process.arch ||
    !/^v\d+\.\d+\.\d+/.test(runtime.node)
  )
    throw new Error('Installed --version did not identify a matching SEA runtime')
  const driver = preparedDirectory
    ? join(preparedDirectory, 'measurement.cjs')
    : await buildMeasurementDriver(join(root, 'measurement.cjs'))
  const output = await new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [driver, root, executable, String(samples), String(ledgerTransactions)], {
      cwd: home,
      env: isolatedEnv(home),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      try {
        if (!stdout.trim()) throw new Error('Measurement driver failed: exit=' + code + ' signal=' + signal)
        resolveOutput({ result: JSON.parse(stdout), code })
      } catch (error) {
        reject(error)
      }
    })
  })
  return {
    ...environment(),
    executableBytes: (await stat(executable)).size,
    runtime,
    ...output.result,
    passed: output.code === 0 && output.result.passed,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const usage =
    'Usage: worker-startup.mjs [samples=100] [--ledger transactions] [--package directory] [--prepare directory | --prepared directory]'
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
    return
  }
  function takeOption(name) {
    const index = args.indexOf(name)
    if (index === -1) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(name + ' requires a value')
    args.splice(index, 2)
    return value
  }
  const prepare = takeOption('--prepare')
  const prepared = takeOption('--prepared')
  const packagePath = takeOption('--package')
  const ledger = takeOption('--ledger')
  const samples = Number(args.shift() ?? 100)
  const ledgerTransactions = Number(ledger ?? 0)
  if (
    (prepare && (prepared || packagePath)) ||
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    args.length ||
    !Number.isSafeInteger(ledgerTransactions) ||
    ledgerTransactions < 0 ||
    (ledger !== undefined && ledgerTransactions < 1)
  )
    throw new Error(usage)
  const preparedDirectory = prepared ? resolve(prepared) : undefined
  if (prepare) {
    const directory = resolve(prepare)
    await mkdir(directory, { recursive: true })
    const driver = await buildMeasurementDriver(join(directory, 'measurement.cjs'))
    console.log(
      JSON.stringify(
        {
          ...environment(),
          prepared: true,
          driver,
          target: 'Node 26; combine --prepared with --package on the measurement platform',
        },
        null,
        2,
      ),
    )
    return
  }
  const output = await withTemporaryInstallation(packagePath, async ({ root, installed }) => {
    if (!packagePath) {
      if (preparedDirectory)
        throw new Error('--prepared requires --package; prepare drivers separately from the target installation')
      const { buildBatond } = await import('./build-batond.mjs')
      const bundle = await buildBatond(join(root, 'batond.cjs'))
      const executable = installedExecutable(installed)
      await buildSea(bundle, executable)
      await Promise.all([rm(bundle), rm(executable + '.json')])
    }
    return measureWorkerStartup({ root, installed, samples, ledgerTransactions, preparedDirectory })
  })
  console.log(JSON.stringify(output, null, 2))
  if (!output.passed) process.exitCode = 1
}

if (process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined)) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.log(JSON.stringify({ ...environment(), passed: false, failure: { message: error.message } }, null, 2))
    process.exitCode = 1
  })
}
