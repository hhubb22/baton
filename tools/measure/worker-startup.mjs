import { spawn, spawnSync } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { environment, isolatedEnv, installedExecutable, withTemporaryInstallation } from '../lib/installation.mjs'

export async function buildMeasurementDriver(output) {
  const { build } = await import('esbuild')
  await build({
    entryPoints: [fileURLToPath(new URL('./worker-driver.mjs', import.meta.url))],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    logLevel: 'silent',
  })
  return output
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
  const version = spawnSync(executable, ['--binary-version'], {
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
    'Usage: worker-startup.mjs [samples=100] [--ledger transactions] --package directory [--prepared directory] | --prepare directory'
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
    (!prepare && !packagePath) ||
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
  const output = await withTemporaryInstallation(packagePath, ({ root, installed }) =>
    measureWorkerStartup({ root, installed, samples, ledgerTransactions, preparedDirectory }),
  )
  console.log(JSON.stringify(output, null, 2))
  if (!output.passed) process.exitCode = 1
}

if (process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined)) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.log(JSON.stringify({ ...environment(), passed: false, failure: { message: error.message } }, null, 2))
    process.exitCode = 1
  })
}
