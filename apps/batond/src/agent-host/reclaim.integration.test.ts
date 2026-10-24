import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { readProcessIdentity } from '../platform/identity.ts'

const fixture = fileURLToPath(new URL('../testing/platform/agent-host-reclaim.mjs', import.meta.url))
const stub = fileURLToPath(new URL('../testing/platform/upstream-stub.mjs', import.meta.url))
let bundle = ''
let host: childProcess.ChildProcess | undefined

beforeAll(async () => {
  bundle = join(await mkdtemp(join(tmpdir(), 'baton-reclaim-fixture-')), 'reclaim.mjs')
  await build({
    entryPoints: [fixture],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    logLevel: 'silent',
  })
})

afterAll(async () => {
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const exited = once(host, 'exit')
  try {
    if (host.pid) process.kill(-host.pid, 'SIGKILL')
  } catch {}
  await exited
})

const gone = async (pids: readonly number[]) => {
  const deadline = performance.now() + 5000
  while ((await Promise.all(pids.map(readProcessIdentity))).some(Boolean)) {
    if (performance.now() > deadline) throw new Error('Upstream descendants still executing')
    await delay(20)
  }
}

describe.skipIf(process.platform === 'win32')('Agent host process reclamation', () => {
  it('kills a detached upstream process and its descendant with the host group', async () => {
    host = childProcess.spawn(process.execPath, [bundle, stub], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    host.stderr?.resume()
    const started = JSON.parse((await once(host.stdout!, 'data').then(([chunk]) => chunk.toString())).trim())
    expect(started.spawnedPid).toBe(started.spawned.pid)
    // The host group policy turns upstream detached spawns into same-group children,
    // so the Worker's single group registration already covers the whole tree.
    expect(started.stubPgid).toBe(started.host)
    host.stdin!.write('stop\n')
    const stopped = JSON.parse((await once(host.stdout!, 'data').then(([chunk]) => chunk.toString())).trim())
    expect(stopped).toEqual({ quiet: true })
    await gone([started.spawned.pid, started.spawned.grandchild])
  })
})
