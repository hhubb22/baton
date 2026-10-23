import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const [
  version = '26.11.1',
  target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`,
  mode,
] = process.argv.slice(2)
if (
  !/^26\.\d+\.\d+$/.test(version) ||
  !['darwin-arm64', 'linux-x64', 'linux-arm64', 'win-x64'].includes(target) ||
  (mode && mode !== '--download')
) {
  throw new Error('Usage: node cache-node.mjs [26.x.y] [darwin-arm64|linux-x64|linux-arm64|win-x64] [--download]')
}
const cache = resolve(process.env.BATON_NODE_CACHE ?? join(homedir(), '.cache/baton/node'))
const directory = join(cache, `v${version}`)
const stem = `node-v${version}-${target}`
const archive = `${stem}.${target.startsWith('win-') ? 'zip' : 'tar.gz'}`
const sums = join(directory, 'SHASUMS256.txt')
const archivePath = join(directory, archive)
const base = `https://nodejs.org/dist/v${version}/`
async function download(name) {
  const response = await fetch(`${base}${name}`)
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`)
  writeFileSync(join(directory, name), Buffer.from(await response.arrayBuffer()))
}
if (mode === '--download') {
  mkdirSync(directory, { recursive: true })
  if (!existsSync(sums)) await download('SHASUMS256.txt')
  if (!existsSync(archivePath)) await download(archive)
}
if (!existsSync(sums) || !existsSync(archivePath)) {
  throw new Error(
    `Cache missing: ${archivePath}. Download explicitly: node tools/ts-migration/cache-node.mjs ${version} ${target} --download`,
  )
}
const line = readFileSync(sums, 'utf8')
  .split('\n')
  .find((entry) => entry.endsWith(`  ${archive}`))
if (!line) throw new Error(`No official SHA256 entry for ${archive}`)
const expected = line.split(/\s+/)[0]
const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
if (actual !== expected) throw new Error(`SHA256 mismatch: ${archive}`)
const executable = join(directory, stem, target.startsWith('win-') ? 'node.exe' : 'bin/node')
if (!existsSync(executable)) {
  if (target.startsWith('win-') && process.platform === 'win32') {
    // Paths are passed through environment, never interpolated into PowerShell source.
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:BATON_ARCHIVE -DestinationPath $env:BATON_EXTRACT -Force',
      ],
      {
        env: { ...process.env, BATON_ARCHIVE: archivePath, BATON_EXTRACT: directory },
        stdio: 'pipe',
        timeout: 60_000,
      },
    )
  } else {
    execFileSync('tar', ['-xf', archivePath, '-C', directory], { stdio: 'pipe', timeout: 60_000 })
  }
}
console.log(
  JSON.stringify({ version, target, executable, archive: archivePath, sha256: actual, checksums: sums }, null, 2),
)
