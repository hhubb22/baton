import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanTelemetryArtifacts } from './lib/telemetry-scan.mjs'

test('rejects deleted telemetry markers in build artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-telemetry-scan-'))
  const file = join(directory, 'artifact')
  try {
    await writeFile(file, 'safe')
    assert.deepEqual(await scanTelemetryArtifacts([directory]), {
      scanned: true,
      directories: 1,
      externalTelemetry: false,
    })

    const replay = ['rr', 'web'].join('')
    await writeFile(file, `${'x'.repeat(65534)}${replay}`)
    await assert.rejects(scanTelemetryArtifacts([directory]), new RegExp(replay))

    const endpoint = ['OTEL', '_EXPORTER', '_OTLP', '_ENDPOINT'].join('')
    await writeFile(file, endpoint)
    await assert.rejects(scanTelemetryArtifacts([directory]), new RegExp(['OTEL', '_EXPORTER', '_OTLP'].join('')))

    assert.deepEqual(await scanTelemetryArtifacts([join(directory, 'missing')]), {
      scanned: true,
      directories: 0,
      externalTelemetry: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('skips third-party package source with unused replay features', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-telemetry-scan-'))
  try {
    const dependency = join(directory, 'node_modules', 'example')
    const archived = join(directory, 'releases', 'old')
    await mkdir(dependency, { recursive: true })
    await mkdir(archived, { recursive: true })
    await writeFile(join(dependency, 'replay.js'), ['rr', 'web'].join(''))
    await writeFile(join(archived, 'old'), ['OTEL', '_EXPORTER', '_OTLP'].join(''))
    assert.equal((await scanTelemetryArtifacts([directory])).externalTelemetry, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
