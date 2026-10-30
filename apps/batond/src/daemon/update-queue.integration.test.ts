import { randomUUID } from 'node:crypto'
import { rm, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { processLockIsHeld, readProcessLock } from '../platform/lock.ts'
import { identityMatches } from '../platform/identity.ts'
import { readLedger } from '../worker/ledger.ts'
import { LocalWorkerHost, initializeWorkerDirectory } from './host.ts'
import { makeNodeLedger } from './ledger.ts'
import { saveUpgradeState } from './upgrade.ts'

it('drains an active turn and resumes a queued input once after update', async () => {
  const directory = await realpath(await makePrivateTempDirectory('bt-uq-'))
  const threadId = randomUUID(),
    generation = randomUUID()
  const paths = await initializeWorkerDirectory(directory, threadId)
  const bundle = join(directory, 'worker.cjs')
  const host = new LocalWorkerHost(directory, { executable: process.execPath, args: [bundle] })
  const config = {
    thread_id: threadId,
    node_id: randomUUID(),
    storage_generation: generation,
    agent_type: 'cursor' as const,
    runtime_mode: 'full-access' as const,
    working_directory: directory,
    execution_timeout_seconds: 60,
    adapter_config: {},
  }
  const base = { ok: false as const, thread_id: threadId, storage_generation: generation }
  const first = randomUUID(),
    second = randomUUID()
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('../testing/replay-worker.ts', import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node26',
      external: ['@cursor/sdk', '@cursor/sdk/*'],
      define: { 'import.meta.url': '__baton_import_meta_url__' },
      banner: { js: 'const __baton_import_meta_url__ = require("node:url").pathToFileURL(__filename).href;' },
      logLevel: 'silent',
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const node = yield* makeNodeLedger(join(directory, 'node.db'))
          yield* node.saveWorker({ threadId, config, ready: false, startup_phase: 'awaiting_open' })
        }),
      ),
    )
    expect(
      (
        await host.request(
          threadId,
          { ...base, type: 'thread_open', command_id: randomUUID(), open_config: config },
          { start: true },
        )
      ).ok,
    ).toBe(true)
    await expect
      .poll(async () => (await host.request(threadId, { type: 'status', ok: false })).agent_ready, { timeout: 10000 })
      .toBe(true)
    expect(
      (
        await host.request(threadId, {
          ...base,
          type: 'thread_message',
          command_id: randomUUID(),
          client_message_id: first,
          payload: 'hold',
        })
      ).ok,
    ).toBe(true)
    await expect
      .poll(async () => readFile(join(directory, 'submissions.jsonl'), 'utf8').catch(() => ''), { timeout: 10000 })
      .toContain(first)
    expect(
      (
        await host.request(threadId, {
          ...base,
          type: 'thread_message',
          command_id: randomUUID(),
          client_message_id: second,
          payload: 'queued',
        })
      ).ok,
    ).toBe(true)
    await expect.poll(() => readLedger(paths.ledger).initial.messages[second]?.state).toBe('queued')
    const state = { operation_id: randomUUID(), source_version: 'v1', target_version: 'v2', phase: 'draining' as const }
    await saveUpgradeState(directory, state)
    await writeFile(join(directory, `${threadId}.release`), '')
    await expect.poll(() => processLockIsHeld(paths.lock), { timeout: 10000 }).toBe(false)
    expect(readLedger(paths.ledger).initial.messages[second]?.state).toBe('queued')
    expect((await readFile(join(directory, 'submissions.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    // The update coordinator opens the queue only after the completed acknowledgement.
    await saveUpgradeState(directory, { ...state, phase: 'completed' })
    await host.ensureWorker(threadId)
    await expect
      .poll(async () => (await readFile(join(directory, 'submissions.jsonl'), 'utf8')).trim().split('\n').length, {
        timeout: 10000,
      })
      .toBe(2)
    const inputs = (await readFile(join(directory, 'submissions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id)
    expect(inputs).toEqual([first, second])
  } finally {
    const lock = await readProcessLock(paths.lock)
    if (lock && (await identityMatches(lock))) {
      process.kill(lock.pid, 'SIGTERM')
      await expect.poll(() => processLockIsHeld(paths.lock), { timeout: 10000 }).toBe(false)
    }
    await rm(directory, { recursive: true, force: true })
  }
})
