import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Fiber, Schema, Stream } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { connectAgentHost } from '../../agent-host/transport.ts'
import { startProcessWatchdog, type ProcessWatchdog } from '../../platform/process.ts'
import { makePrivateTempDirectory } from '../../testing/private.ts'
import { replayProcessRecords } from '../../testing/platform/process-records.ts'
import { readKiroTranscript, writeKiroTranscript, type Transcript } from '../../testing/kiro/transcripts.ts'
import type { AgentEvent, AgentMessage, ThreadAgent } from '../../worker/agent.ts'
import { makeThreadAgentFactory } from '../thread-agents.ts'
import { droidTurnFailure } from './host-driver.ts'

const probeFixture = fileURLToPath(new URL('../../testing/droid/probe.ndjson', import.meta.url))
const turnFixture = fileURLToPath(new URL('../../testing/droid/approved-turn.ndjson', import.meta.url))
const bundle = fileURLToPath(new URL('../../../dist/test/droid-replay-host.mjs', import.meta.url))
const watchdogBundle = fileURLToPath(new URL('../../../dist/test/droid-watchdog.mjs', import.meta.url))
const sources: readonly (readonly [string, string])[] = [
  [fileURLToPath(new URL('../../testing/droid/replay-host.ts', import.meta.url)), bundle],
  [
    fileURLToPath(
      new URL(
        '../../../../../upstream/t3code/packages/provider-acp-registry/src/testing/acp-replay-agent.ts',
        import.meta.url,
      ),
    ),
    join(dirname(bundle), 'droid-replay-agent.mjs'),
  ],
  [fileURLToPath(new URL('../../testing/platform/watchdog-entry.ts', import.meta.url)), watchdogBundle],
]
const agents: ThreadAgent[] = []
const fibers: Fiber.Fiber<unknown, unknown>[] = []
const directories: string[] = []
let watchdog: ProcessWatchdog | undefined

beforeAll(async () => {
  await mkdir(dirname(bundle), { recursive: true })
  for (const [entry, outfile] of sources) {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
  }
  if (process.platform !== 'win32')
    watchdog = await startProcessWatchdog({ file: process.execPath, args: [watchdogBundle] })
})

afterAll(async () => {
  await watchdog?.close()
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber))
  for (const agent of agents.splice(0)) await Effect.runPromise(agent.reap())
  for (const directory of directories.splice(0)) {
    expect(replayProcessRecords(directory).list()).toEqual([])
    await rm(directory, { recursive: true, force: true })
  }
})

const effect = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program)

const workspace = async (): Promise<WorkerOpenConfig> => {
  const directory = await makePrivateTempDirectory('baton-droid-')
  directories.push(directory)
  return {
    thread_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    storage_generation: '33333333-3333-4333-8333-333333333333',
    agent_type: 'droid',
    runtime_mode: 'approval-required',
    working_directory: directory,
    execution_timeout_seconds: 30,
    model: 'gemini-3.8-flash',
    adapter_config: { state_path: join(directory, 'private', 'native.json') },
  }
}

const write = async (config: WorkerOpenConfig, name: string, transcript: Transcript) => {
  const path = join(config.working_directory, `${name}.ndjson`)
  await writeKiroTranscript(path, transcript)
  return path
}

const ReplayStatus = Schema.Struct({
  cursor: Schema.Number,
  total: Schema.Number,
  failure: Schema.optional(Schema.Unknown),
})
const consumed = async (path: string, transcript: Transcript) => {
  await expect
    .poll(
      async () => Schema.decodeUnknownSync(ReplayStatus)(JSON.parse(await readFile(`${path}.status.json`, 'utf8'))),
      {
        timeout: 10_000,
      },
    )
    .toEqual({ cursor: transcript.entries.length, total: transcript.entries.length })
}

describe('Droid Agent host', () => {
  it.each([
    {
      code: '-32000',
      message: 'Authentication required',
      expected: 'Sign in to the Factory Droid CLI and try again.',
    },
    {
      code: '-32000',
      message: 'The selected model is unavailable',
      expected: 'Sign in to the Factory Droid CLI and try again.',
    },
    {
      code: '-32001',
      message: 'Authentication required',
      expected: 'Sign in to the Factory Droid CLI and try again.',
    },
    {
      code: '-32001',
      message: 'The selected model is unavailable',
      expected: 'Check the Factory Droid CLI on this device and try again.',
    },
  ])('maps turn failures: $code $message', ({ code, message, expected }) => {
    expect(droidTurnFailure({ class: 'provider_error', code, message, retryable: null })).toBe(expected)
  })

  it('reads models and the default reasoning effort without prompting', async () => {
    const config = await workspace()
    const transcript = await readKiroTranscript(probeFixture)
    const path = await write(config, 'probe', transcript)
    const controller = new AbortController()
    const host = await effect(
      connectAgentHost(
        {
          agentType: 'droid',
          command: { file: process.execPath, args: [bundle, '--transcript', path] },
          records: replayProcessRecords(config.working_directory),
          paths: {
            workingDirectory: config.working_directory,
            privateDirectory: join(config.working_directory, 'private'),
          },
          ...(watchdog ? { watchdog } : {}),
        },
        controller.signal,
      ),
    )
    try {
      const probe = await effect(host.probe)
      expect(probe).toMatchObject({ authenticated: 'unknown', details: { installed: true, version: '1.1.0' } })
      expect(probe.models).toContain('auto')
      expect(probe.models).toContain('gemini-3.8-flash')
      expect(probe.model_thinking?.find((entry) => entry.model === 'auto')?.thinking).toMatchObject({
        id: 'reasoning_effort',
      })
      await consumed(path, transcript)
    } finally {
      controller.abort()
      await effect(host.disconnect)
      expect((await effect(host.reap)).processTreeStopped).toBe(true)
    }
  })

  it('opens in the supervised mode, waits for an approval and finishes the turn after it is accepted', async () => {
    const config = await workspace()
    const transcript = await readKiroTranscript(turnFixture)
    const path = await write(config, 'turn', transcript)
    const agent = makeThreadAgentFactory({
      dataDirectory: config.working_directory,
      command: { file: process.execPath, args: [bundle, '--transcript', path] },
      records: replayProcessRecords(config.working_directory),
      ...(watchdog ? { watchdog } : {}),
    })(config)
    agents.push(agent)
    const events: AgentEvent[] = []
    fibers.push(Effect.runFork(Stream.runForEach(agent.events, (event) => Effect.sync(() => void events.push(event)))))

    await effect(agent.open(config))
    const input: AgentMessage = {
      id: 'turn',
      text: 'Create the file',
      epoch: 1,
      operationId: 'operation-turn',
      mode: 'queue',
      thinking: { id: 'reasoning_effort', value: 'low' },
    }
    await effect(agent.send(input, await effect(agent.prepareInput(input, 0))))

    await expect.poll(() => events.some((event) => event.type === 'question'), { timeout: 10_000 }).toBe(true)
    expect(events.some((event) => event.type === 'end')).toBe(false)
    const pending = events.find((event) => event.type === 'question')
    if (pending?.type !== 'question') throw new Error('Missing approval question')
    expect(pending.question).toMatchObject({ kind: 'approval', request_kind: 'command' })
    await effect(agent.answer!({ request_id: pending.question.request_id, decision: 'accept' }))

    await expect.poll(() => events.some((event) => event.type === 'end'), { timeout: 10_000 }).toBe(true)
    expect(events.filter((event) => event.type === 'uncertain')).toEqual([])
    expect(events.filter((event) => event.type === 'reply')).toEqual([
      expect.objectContaining({ messageId: 'turn', text: 'finished' }),
    ])
    await effect(agent.close())
    expect((await effect(agent.reap())).processTreeStopped).toBe(true)
    await consumed(path, transcript)
  })
})
