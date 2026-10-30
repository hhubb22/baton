import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnv } from '../lib/installation.mjs'

if (process.platform !== 'win32' || !process.env.SystemRoot) throw new Error('Windows SystemRoot required')

const home = await mkdtemp(join(tmpdir(), 'baton-windows-diagnostic-'))
const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const query = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}'; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }`

async function probe(
  profile,
  explicit = false,
  systemPath = false,
  startupOnly = false,
  inherited = false,
  dotnet = false,
) {
  const start = performance.now()
  const dotnetQuery = `[Console]::Out.WriteLine([Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))`
  const source = `$ErrorActionPreference = 'Stop'; [Console]::Out.WriteLine('STARTED'); ${explicit ? "Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1'); [Console]::Out.WriteLine('IMPORTED'); " : ''}${startupOnly ? '' : dotnet ? dotnetQuery : query}`
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]
  const child = spawn(executable, args, {
    env: {
      ...(inherited ? process.env : isolatedEnv(profile)),
      ...(systemPath ? { PATH: join(process.env.SystemRoot, 'System32') } : {}),
      LC_ALL: 'C',
      TZ: 'UTC',
    },
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk.toString()).slice(0, 4096)
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(0, 4096)
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    const stderrCategories = [
      ...new Set(
        stderr.match(
          /(?:CommandNotFoundException|ModuleNotFoundException|CimException|UnauthorizedAccessException|OperationTimeout|FullyQualifiedErrorId)/g,
        ) ?? [],
      ),
    ]
    return {
      ...result,
      elapsedMs: Math.round(performance.now() - start),
      identityValid: /^\d+$/m.test(stdout),
      identity: stdout.match(/^\d+$/m)?.[0],
      stages: ['STARTED', 'IMPORTED'].filter((stage) => stdout.includes(stage)),
      stderrCategories,
      stderr: stderr.replaceAll(home, '<temporary-home>').slice(0, 2000),
    }
  } finally {
    clearTimeout(timer)
  }
}

try {
  const profiles = ['auto', 'explicit', 'concurrent', 'startup', 'systempath'].map((name) => join(home, name))
  await Promise.all(profiles.map((profile) => mkdir(profile)))
  const cold = await probe(profiles[0])
  const warm = await probe(profiles[0])
  const explicit = await probe(profiles[1], true)
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => probe(profiles[2])))
  const [startup, systemPath] = await Promise.all([
    probe(profiles[3], false, false, true),
    probe(profiles[4], false, true),
  ])
  const inherited = await probe(home, false, false, false, true)
  const native = await probe(home, false, false, false, false, true)
  const identityMatches = inherited.identity === native.identity && native.identityValid
  delete inherited.identity
  delete native.identity
  console.log(
    JSON.stringify(
      {
        emptyPath: true,
        temporaryHome: true,
        cold,
        warm,
        explicit,
        concurrent,
        startup,
        systemPath,
        inherited,
        native,
        identityMatches,
      },
      null,
      2,
    ),
  )
  if ([cold, warm, explicit, ...concurrent].some((result) => result.exitCode !== 0 || !result.identityValid))
    process.exitCode = 1
} finally {
  await rm(home, { recursive: true, force: true })
}
