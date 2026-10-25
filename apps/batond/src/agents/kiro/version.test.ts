import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Schema } from 'effect'
import { NodeServices } from '@effect/platform-node'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { readProcessIdentity } from '../../platform/identity.ts'
import { kiroVersion } from './version.ts'

const directories: string[] = []
const Calls = Schema.Struct({ args: Schema.Array(Schema.String), pid: Schema.Int })
const readCalls = async (path: string) => Schema.decodeUnknownSync(Calls)(JSON.parse(await readFile(path, 'utf8')))

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const executable = async (body: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-kiro-version-'))
  directories.push(directory)
  const binary = join(directory, 'kiro-cli')
  const calls = join(directory, 'calls.json')
  await writeFile(
    binary,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }));\nif (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(2);\n${body}\n`,
    { mode: 0o700 },
  )
  return { directory, binary, calls }
}

const probe = (directory: string, binary: string, timeout?: number) =>
  Effect.runPromise(
    kiroVersion({
      cwd: directory,
      binary,
      environment: { PATH: '' },
      ...(timeout === undefined ? {} : { timeout }),
    }).pipe(Effect.provide(NodeServices.layer)),
  )

describe.skipIf(process.platform === 'win32')('Kiro version executable probe', () => {
  it.each([
    { output: 'kiro-cli 2.32.0\nprivate diagnostic', stream: 'stdout', version: '2.32.0' },
    { output: 'kiro-cli v2.32.0', stream: 'stderr', version: '2.32.0' },
    { output: 'kiro-cli 2.32.0-preview.1+build.7', stream: 'stdout', version: '2.32.0-preview.1+build.7' },
  ])('returns only the version from $stream: $version', async ({ output, stream, version }) => {
    const command = await executable(`process.${stream}.write(${JSON.stringify(output)});`)
    expect(await probe(command.directory, command.binary)).toEqual({ state: 'ready', version })
    expect(await readCalls(command.calls)).toMatchObject({ args: ['--version'] })
  })

  it('keeps unparseable diagnostics out of the result', async () => {
    const command = await executable("process.stderr.write('private diagnostic without a version');")
    expect(await probe(command.directory, command.binary)).toEqual({ state: 'invalid', version: 'unknown' })
  })

  it('does not accept a version printed by a failed command', async () => {
    const command = await executable("process.stdout.write('kiro-cli 2.32.0'); process.exitCode = 1;")
    expect(await probe(command.directory, command.binary)).toEqual({ state: 'failed', version: 'unknown' })
  })

  it('reports a missing executable without falling back to an installed CLI', async () => {
    const command = await executable('')
    expect(await probe(command.directory, join(command.directory, 'missing-kiro-cli'))).toEqual({
      state: 'missing',
      version: 'unknown',
    })
  })

  it('times out and reaps a version command that never exits', async () => {
    const command = await executable('setInterval(() => {}, 1000);')
    expect(await probe(command.directory, command.binary, 1000)).toEqual({ state: 'timeout', version: 'unknown' })
    const { pid } = await readCalls(command.calls)
    expect(await readProcessIdentity(pid)).toBeNull()
  })
})
