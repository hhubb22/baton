import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { Effect, Fiber, Stream } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { startProcessWatchdog, type ProcessWatchdog } from '../../platform/process.ts'
import { makePiAgentFactory } from './index.ts'
import type { AgentEvent, AgentMessage, ThreadAgent } from '../../worker/agent.ts'

const fixture = (name: string) =>
  fileURLToPath(
    new URL(
      `../../../../../upstream/t3code/apps/server/src/orchestration-v2/testkit/fixtures/${name}/pi_transcript.ndjson`,
      import.meta.url,
    ),
  )
const source = fileURLToPath(new URL('../../testing/pi/replay-host.ts', import.meta.url))
const watchdogSource = fileURLToPath(new URL('../../testing/cursor/watchdog-entry.ts', import.meta.url))
const bundle = fileURLToPath(new URL('../../../dist/test/pi-replay-host.mjs', import.meta.url))
const watchdogBundle = fileURLToPath(new URL('../../../dist/test/watchdog.mjs', import.meta.url))
const agents: ThreadAgent[] = []
const fibers: Fiber.Fiber<unknown, unknown>[] = []
let watchdog: ProcessWatchdog | undefined

beforeAll(async () => {
  await mkdir(dirname(bundle), { recursive: true })
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
  if (process.platform !== 'win32') {
    await build({
      entryPoints: [watchdogSource],
      outfile: watchdogBundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      logLevel: 'silent',
    })
    watchdog = await startProcessWatchdog({ file: process.execPath, args: [watchdogBundle] })
  }
})

afterAll(async () => {
  await watchdog?.close()
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber))
  for (const agent of agents.splice(0)) {
    await Effect.runPromise(agent.reap().pipe(Effect.catch(() => Effect.succeed({ processTreeStopped: false }))))
  }
})

const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 10_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for Pi events')
    await delay(20)
  }
}

const start = async (name: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-pi-thread-'))
  const config: WorkerOpenConfig = {
    thread_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    storage_generation: '33333333-3333-4333-8333-333333333333',
    agent_type: 'pi',
    working_directory: directory,
    execution_timeout_seconds: 30,
    model: 'openrouter/deepseek/deepseek-v4-flash',
    adapter_config: { state_path: join(directory, 'private', 'native.json') },
  }
  const agent = makePiAgentFactory({
    command: { file: process.execPath, args: [bundle, '--transcript', fixture(name)] },
    ...(watchdog ? { watchdog } : {}),
    paths: (value) => {
      const statePath = value.adapter_config.state_path
      if (statePath === undefined) throw new Error('Pi replay requires state_path')
      return { workingDirectory: value.working_directory, privateDirectory: dirname(statePath) }
    },
  })(config)
  agents.push(agent)
  const events: AgentEvent[] = []
  fibers.push(Effect.runFork(Stream.runForEach(agent.events, (event) => Effect.sync(() => void events.push(event)))))
  return { agent, events, config }
}

const message = (id: string, text: string): AgentMessage => ({
  id,
  text,
  epoch: 1,
  operationId: `operation-${id}`,
  mode: 'queue',
})

describe('Pi Agent host', () => {
  it('opens a session and completes one upstream replay turn', async () => {
    const { agent, events, config } = await start('simple')
    const opened = await Effect.runPromise(agent.open(config))
    expect(opened.nativeSessionId).not.toBe('')
    const input = message('simple-1', 'Respond with the following text: fixture simple ok')
    await Effect.runPromise(agent.send(input, await Effect.runPromise(agent.prepareInput(input, 0))))
    await waitFor(() => events.some((event) => event.type === 'end'))
    expect(
      events
        .filter((event) => event.type === 'reply')
        .map((event) => (event.type === 'reply' ? event.text : ''))
        .join(''),
    ).toContain('fixture simple ok')
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'completed' })
    await Effect.runPromise(agent.close())
    expect((await Effect.runPromise(agent.reap())).processTreeStopped).toBe(true)
  })

  it('keeps a second turn on the same native session', async () => {
    const { agent, events, config } = await start('multi_turn')
    await Effect.runPromise(agent.open(config))
    const first = message('multi-1', 'Respond with exactly: first fixture turn complete')
    await Effect.runPromise(agent.send(first, await Effect.runPromise(agent.prepareInput(first, 0))))
    await waitFor(() => events.some((event) => event.type === 'end'))
    const second = message('multi-2', 'Respond with exactly: second fixture turn complete')
    await Effect.runPromise(agent.send(second, await Effect.runPromise(agent.prepareInput(second, 1))))
    await waitFor(() => events.filter((event) => event.type === 'end').length === 2)
    expect(events.some((event) => event.type === 'uncertain')).toBe(false)
    await Effect.runPromise(agent.close())
  })

  it('cancels a turn while a tool is running', async () => {
    const { agent, events, config } = await start('turn_interrupt_mid_tool')
    await Effect.runPromise(agent.open(config))
    const input = message(
      'interrupt-1',
      'Run this exact local command: `node -e "console.log(\'interrupt fixture tool started\'); setTimeout(() => {}, 30000)"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.',
    )
    await Effect.runPromise(agent.send(input, await Effect.runPromise(agent.prepareInput(input, 0))))
    await delay(100)
    await Effect.runPromise(agent.abort())
    await waitFor(() => events.some((event) => event.type === 'end'))
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'cancelled' })
  })
})
