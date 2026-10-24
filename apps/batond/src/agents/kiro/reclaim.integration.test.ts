import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { connectAgentHost, type AgentHostConnection } from '../../agent-host/transport.ts'
import { readProcessIdentity, systemCommand, type ProcessIdentity } from '../../platform/identity.ts'
import { reapProcessTree } from '../../platform/process-tree.ts'
import { startProcessWatchdog } from '../../platform/watchdog.ts'
import type { ProcessWatchdog } from '../../platform/process-types.ts'

const source = fileURLToPath(new URL('../../testing/platform/kiro-agent-host-reclaim.mjs', import.meta.url))
const stub = fileURLToPath(new URL('../../testing/platform/kiro-acp-reclaim-stub.mjs', import.meta.url))
const Pids = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(1)),
  grandchild: Schema.Int.check(Schema.isGreaterThan(1)),
  methods: Schema.Array(Schema.String),
})
const decodePids = Schema.decodeUnknownSync(Schema.fromJsonString(Pids))
const connections: AgentHostConnection[] = []
const acpGroups: ProcessIdentity[] = []
const directories: string[] = []
let buildDirectory = ''
let bundle = ''
let watchdog: ProcessWatchdog | undefined

const groupOf = async (pid: number) => Number(await systemCommand('/bin/ps', ['-p', String(pid), '-o', 'pgid=']))
const waitForExit = async (pids: readonly number[]) => {
  const deadline = performance.now() + 8000
  while ((await Promise.all(pids.map(readProcessIdentity))).some(Boolean)) {
    if (performance.now() >= deadline) throw new Error(`Kiro processes still executing: ${pids.join(', ')}`)
    await delay(20)
  }
}

describe.skipIf(process.platform === 'win32')('Kiro ACP local process reclamation', () => {
  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), 'baton-kiro-reclaim-build-'))
    bundle = join(buildDirectory, 'kiro-host.mjs')
    await build({
      entryPoints: [source],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
    watchdog = await startProcessWatchdog({ file: process.execPath, args: [bundle, 'watchdog'] })
  })

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      await Effect.runPromise(connection.disconnect)
      await Effect.runPromise(connection.reap)
    }
    for (const identity of acpGroups.splice(0)) await reapProcessTree(identity)
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  afterAll(async () => {
    await watchdog?.close()
    if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
  })

  for (const shutdown of ['SIGTERM', 'SIGKILL']) {
    it(`reclaims the ACP process and same-group grandchild after host ${shutdown}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'baton-kiro-reclaim-'))
      directories.push(directory)
      let hostPid = 0
      const connection = await Effect.runPromise(
        connectAgentHost(
          {
            command: { file: process.execPath, args: [bundle, '--stub', stub] },
            agentType: 'kiro',
            paths: { workingDirectory: directory, privateDirectory: directory },
            ...(watchdog ? { watchdog } : {}),
            records: {
              add: async (record) => {
                hostPid = record.pid
              },
              remove: async () => {},
            },
          },
          new AbortController().signal,
        ),
      )
      connections.push(connection)
      const config: WorkerOpenConfig = {
        thread_id: randomUUID(),
        node_id: randomUUID(),
        storage_generation: randomUUID(),
        agent_type: 'kiro',
        working_directory: directory,
        execution_timeout_seconds: 30,
        adapter_config: { state_path: join(directory, 'native.json') },
      }
      const opened = await Effect.runPromise(connection.open(config, randomUUID()))
      expect(opened.nativeSessionId).toBe('kiro-local-reclaim')
      const pids = decodePids(await readFile(join(directory, 'kiro-pids.json'), 'utf8'))
      expect(pids.methods).toEqual(['initialize', 'session/new'])
      const acpIdentity = await readProcessIdentity(pids.pid)
      if (acpIdentity) acpGroups.push(acpIdentity)
      expect(acpIdentity).not.toBeNull()
      expect(await readProcessIdentity(pids.grandchild)).not.toBeNull()
      const groups = {
        host: await groupOf(hostPid),
        acp: await groupOf(pids.pid),
        grandchild: await groupOf(pids.grandchild),
      }
      expect(groups.host).toBe(hostPid)
      expect(groups.acp).toBe(pids.pid)
      expect(groups.grandchild).toBe(groups.acp)
      expect(groups.acp).not.toBe(groups.host)
      if (shutdown === 'SIGTERM') {
        await Effect.runPromise(connection.close)
        process.kill(hostPid, 'SIGTERM')
      } else {
        // Kill only the host: its registrar watchdog owns the separate ACP group.
        process.kill(hostPid, 'SIGKILL')
        await Effect.runPromise(connection.disconnect)
      }
      await waitForExit([hostPid, pids.pid, pids.grandchild])
      console.log(JSON.stringify({ shutdown, hostPid, ...pids, groups, exited: true }))
    }, 20_000)
  }
})
