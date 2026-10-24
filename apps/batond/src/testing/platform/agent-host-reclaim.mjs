import childProcess from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect } from 'effect'
import { ChildProcess } from 'effect/process'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { signalProcessGroup } from '@t3tools/provider-core/server/processGroup'
import { installHostProcessGroup } from '../../platform/host-process-group.ts'
import { agentHostLayer } from '../../agent-host/host-layer.ts'
import { makeProcessRegistrar } from '../../agent-host/process-registrar.ts'
import { runWatchdogCommand } from '../../platform/watchdog.ts'

if (process.argv[2] === 'watchdog') {
  await runWatchdogCommand()
  process.exit(0)
}

const stub = process.argv[2]
const ownGroup = process.argv[3] === 'own-group'
if (!stub) throw new Error('Missing upstream stub path')
const directory = await mkdtemp(join(tmpdir(), 'baton-agent-host-reclaim-'))
const pidFile = join(directory, 'pids.json')
const policy = installHostProcessGroup({ foldDetached: !ownGroup })
const registrar = await Effect.runPromise(makeProcessRegistrar())
const layer = agentHostLayer({
  paths: { workingDirectory: directory, privateDirectory: directory },
  registrar,
})
const emit = (value) => console.log(JSON.stringify(value))
const readPids = () =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return JSON.parse(await readFile(pidFile, 'utf8'))
      } catch {
        await delay(20)
      }
    }
    throw new Error('Stub did not start')
  })
const groupOf = (pid) =>
  Effect.sync(() =>
    Number(
      childProcess
        .execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
          encoding: 'utf8',
          env: { LC_ALL: 'C', PATH: '' },
        })
        .trim(),
    ),
  )
const waitForStop = () =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin })
        lines.once('line', () => {
          lines.close()
          resolve(undefined)
        })
      }),
  )
await Effect.runPromise(
  Effect.scoped(
    Effect.provide(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [stub, pidFile], {
            detached: true,
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
          }),
        )
        const pids = yield* readPids()
        emit({
          spawned: pids,
          host: process.pid,
          stubPgid: yield* groupOf(pids.pid),
          spawnedPid: Number(handle.pid),
        })
        yield* waitForStop()
        if (ownGroup) {
          // Same signal Pi uses on its detached process group.
          signalProcessGroup(Number(handle.pid), 'SIGKILL')
          yield* registrar.release(Number(handle.pid))
        } else {
          yield* Effect.promise(() => policy.terminateChildren({ timeoutMs: 5000 }))
          yield* Effect.promise(() => policy.waitQuiescent({ timeoutMs: 2000 }))
        }
        emit({ quiet: true })
      }),
      layer,
    ),
  ),
)
await Effect.runPromise(registrar.close)
policy.restore()
process.exit(0)
