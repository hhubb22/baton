import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { arch, cpus, platform, release } from 'node:os'
import { execFileSync } from 'node:child_process'

export function dependencyRequire() {
  const root = process.env.BATON_MEASURE_DEPS
  if (!root) throw new Error('Set BATON_MEASURE_DEPS to the isolated dependency directory (see README.md).')
  return createRequire(join(resolve(root), 'package.json'))
}

export function environment() {
  return { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model }
}

export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return { count: sorted.length, p50Ms: percentile(0.5), p99Ms: percentile(0.99), maxMs: sorted.at(-1) }
}

// Probe children receive no provider credentials or personal configuration paths.
export function isolatedEnv(home) {
  const env = { HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, PATH: '', NO_COLOR: '1' }
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

export function buildSea(main, output) {
  const config = `${output}.json`
  return import('node:fs').then(({ writeFileSync }) => {
    writeFileSync(
      config,
      JSON.stringify({
        main,
        output,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
        execArgvExtension: 'none',
      }),
    )
    execFileSync(process.execPath, ['--build-sea', config], { stdio: 'pipe', timeout: 60_000 })
    if (process.platform === 'darwin')
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'pipe', timeout: 60_000 })
    return output
  })
}
