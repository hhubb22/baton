import { Duration, Effect } from 'effect'
import { ChildProcess } from 'effect/process'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { collectUint8StreamText } from '@t3tools/provider-core/server/collectStreamText'
import { isCommandMissingCause } from '@t3tools/provider-core/server/snapshotProbe'

export interface KiroVersionResult {
  readonly state: 'ready' | 'missing' | 'timeout' | 'invalid' | 'failed'
  readonly version: string
}

const result = (state: KiroVersionResult['state'], version = 'unknown'): KiroVersionResult => ({ state, version })

/** Capture only the version; command output and diagnostics stay inside the host. */
export const kiroVersion = Effect.fn('Kiro.version')(function* (input: {
  readonly cwd: string
  readonly binary?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly timeout?: Duration.Input
}) {
  const spawner = yield* ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.binary ?? 'kiro-cli', ['--version'], {
          cwd: input.cwd,
          env: input.environment ?? process.env,
          extendEnv: false,
          shell: false,
          stdin: 'ignore',
        }),
      )
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 4096 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 4096 }),
          child.exitCode,
        ],
        { concurrency: 'unbounded' },
      )
      if (Number(code) !== 0) return result('failed')
      if (stdout.truncated || stderr.truncated || stdout.invalidUtf8 || stderr.invalidUtf8) return result('invalid')
      const match = `${stdout.text}\n${stderr.text}`.match(
        /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|\s|[,)])/u,
      )
      return match?.[1] ? result('ready', match[1]) : result('invalid')
    }).pipe(Effect.timeout(input.timeout ?? '4 seconds')),
  ).pipe(
    Effect.catchTag('TimeoutError', () => Effect.succeed(result('timeout'))),
    Effect.catch((cause) => Effect.succeed(result(isCommandMissingCause(cause) ? 'missing' : 'failed'))),
  )
})
