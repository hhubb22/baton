import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanTelemetryArtifacts } from './lib/telemetry-scan.mjs'

test('detects endpoint and decoded header values without reporting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-telemetry-scan-'))
  const file = join(directory, 'artifact')
  try {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/scan-marker',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=scan%2Dsecret',
    }
    await writeFile(file, 'safe')
    const clean = await scanTelemetryArtifacts([directory], env)
    assert.equal(clean.scanned, true)
    assert.equal(clean.directories, 1)
    await writeFile(file, `${'x'.repeat(65534)}scan-secret`)
    await assert.rejects(scanTelemetryArtifacts([directory], env), (error) => {
      assert.match(error.message, /OTEL_EXPORTER_OTLP_HEADERS/)
      assert.doesNotMatch(error.message, /scan-secret/)
      return true
    })
    await writeFile(file, env.OTEL_EXPORTER_OTLP_ENDPOINT)
    await assert.rejects(scanTelemetryArtifacts([directory], env), /OTEL_EXPORTER_OTLP_ENDPOINT/)
    assert.deepEqual(await scanTelemetryArtifacts([directory], {}), { provided: [], scanned: false, directories: 1 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
