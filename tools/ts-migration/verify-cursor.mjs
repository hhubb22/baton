import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, access, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

// Explicit manual validation uses real inference and a disposable local workspace.
if (!process.argv.includes('--bundled')) {
  if (!process.env.CURSOR_API_KEY?.trim()) throw new Error('Set CURSOR_API_KEY for real Cursor validation')
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const bundle = join(repository, 'apps/batond/dist/batond.cjs')
  const built = spawnSync(process.execPath, [join(repository, 'tools/ts-migration/build-batond.mjs')], {
    encoding: 'utf8',
  })
  if (built.status !== 0) throw new Error('Cannot build the local batond')
  const output = join(dirname(bundle), 'verify-cursor.mjs')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    outfile: output,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'esm',
    external: ['esbuild'],
    logLevel: 'silent',
  })
  const child = spawnSync(process.execPath, [output, '--bundled', '--batond', bundle, ...process.argv.slice(2)], {
    stdio: 'inherit',
    timeout: 300_000,
  })
  process.exitCode = child.status ?? 1
} else {
  const { LocalWorkerHost } = await import('../../apps/batond/src/daemon/host.ts')
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'baton-real-'))
  const workspace = join(root, 'work')
  await mkdir(workspace, { mode: 0o700 })
  const data = join(root, 'data')
  const threadId = randomUUID()
  const storageGeneration = randomUUID()
  const host = new LocalWorkerHost(data, {
    executable: process.execPath,
    args: [process.argv[process.argv.indexOf('--batond') + 1]],
  })
  const identity = { ok: false, thread_id: threadId, storage_generation: storageGeneration }
  const command = (type, fields = {}) => ({ ...identity, type, command_id: randomUUID(), ...fields })
  let lastPid
  const readReports = async () => {
    const result = await host.request(threadId, { type: 'thread_pending', ok: false })
    assert.equal(result.ok, true)
    return result.thread_reports ?? []
  }
  const waitFor = async (read, predicate, timeout = 90_000) => {
    const deadline = performance.now() + timeout
    while (performance.now() < deadline) {
      const value = await read()
      if (predicate(value)) return value
      await delay(100)
    }
    throw new Error('Cursor validation deadline exceeded')
  }
  const completed = async (request, expected = 'succeeded') => {
    const result = await host.request(threadId, request, { start: true })
    assert.equal(result.ok, true, result.code)
    const reports = await waitFor(readReports, (items) =>
      items.some((item) => item.command_id === request.command_id && item.kind === 'command.completed'),
    )
    const outcome = reports.find((item) => item.command_id === request.command_id && item.kind === 'command.completed')
    assert.equal(outcome.command_outcome, expected, outcome.reason)
    return reports
  }
  const snapshotProcesses = () => {
    if (process.platform === 'win32') return []
    return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                group: Number(match[3]),
                state: match[4],
                command: match[5],
              },
            ]
          : []
      })
  }
  const ownedProcesses = () => {
    const processes = snapshotProcesses()
    const owned = new Set(
      processes.filter((row) => row.parent === lastPid && row.command.includes('cursor-host')).map((row) => row.pid),
    )
    let size = -1
    while (size !== owned.size) {
      size = owned.size
      for (const row of processes) if (owned.has(row.parent)) owned.add(row.pid)
    }
    return processes.filter((row) => owned.has(row.pid))
  }
  const history = async () => {
    const result = await host.request(threadId, { type: 'native_history', ok: false }, { timeoutMs: 10_000 })
    assert.equal(result.ok, true, result.code)
    return result.history
  }
  const message = (text) => command('thread_message', { client_message_id: randomUUID(), payload: text, mode: 'queue' })
  const turnEnded = (request) =>
    waitFor(readReports, (items) =>
      items.some((item) => item.kind === 'turn.ended' && item.client_message_id === request.client_message_id),
    )
  try {
    const start = performance.now()
    await host.ensureWorker(threadId)
    const readyMs = performance.now() - start
    const status = await host.request(threadId, { type: 'status', ok: false })
    lastPid = status.pid
    assert.equal(status.worker_ready, true)
    assert.equal(status.agent_ready, false)
    const open = command('thread_open', {
      open_config: {
        thread_id: threadId,
        node_id: randomUUID(),
        storage_generation: storageGeneration,
        agent_type: 'cursor',
        working_directory: await import('node:fs/promises').then((fs) => fs.realpath(workspace)),
        execution_timeout_seconds: 180,
        ...(process.argv.includes('--model') ? { model: process.argv[process.argv.indexOf('--model') + 1] } : {}),
        adapter_config: { state_path: join(data, 'threads', threadId, 'native.json') },
      },
    })
    const opened = await completed(open)
    const nativeId = opened.find((item) => item.kind === 'thread.opened').native_session_id
    assert.ok(nativeId)
    console.log(JSON.stringify({ checkpoint: 'opened', workerReadyMs: readyMs }))
    const first = message('Reply with exactly BATON_CURSOR_FIRST. Do not use tools or change files.')
    await completed(first)
    await turnEnded(first)
    assert.equal((await host.request(threadId, first)).ok, true)
    const second = message('Reply with exactly BATON_CURSOR_SECOND. Do not use tools or change files.')
    await completed(second)
    await turnEnded(second)
    const replies = await readReports()
    assert.ok(replies.some((item) => item.kind === 'reply' && item.content?.includes('BATON_CURSOR_FIRST')))
    assert.ok(replies.some((item) => item.kind === 'reply' && item.content?.includes('BATON_CURSOR_SECOND')))
    console.log(JSON.stringify({ checkpoint: 'multi_turn_and_retry' }))
    await completed(command('thread_stop'))
    const stoppedHistory = await history()
    assert.ok(JSON.stringify(stoppedHistory).includes('BATON_CURSOR_FIRST'))
    assert.ok(JSON.stringify(stoppedHistory).includes('BATON_CURSOR_SECOND'))
    assert.equal(stoppedHistory.messages.filter((item) => item.role === 'user').length, 2)
    console.log(JSON.stringify({ checkpoint: 'independent_history' }))
    await completed(command('thread_resume'))
    const resumed = await readReports()
    assert.equal(resumed.findLast((item) => item.kind === 'thread.resumed').native_session_id, nativeId)
    const tool = message(
      `Use the shell tool to run this command in the workspace: printf started > baton-started; sleep 120. Do not run any other command. After it finishes reply BATON_CURSOR_TOOL_DONE.`,
    )
    await completed(tool)
    await waitFor(
      async () =>
        access(join(workspace, 'baton-started')).then(
          () => true,
          () => false,
        ),
      Boolean,
    )
    const owned = ownedProcesses()
    if (process.platform !== 'win32') assert.ok(owned.length > 1, 'The real tool must have owned descendants')
    const stopStart = performance.now()
    await completed(command('thread_stop'))
    if (owned.length)
      await waitFor(
        async () => snapshotProcesses(),
        (current) =>
          owned.every((prior) => !current.some((row) => row.pid === prior.pid && row.command === prior.command)),
        3000,
      )
    const stopMs = performance.now() - stopStart
    const afterStop = await readReports()
    assert.ok(afterStop.some((item) => item.kind === 'turn.ended' && item.client_message_id === tool.client_message_id))
    console.log(JSON.stringify({ checkpoint: 'tool_cancelled', stopMs, capturedProcessesReaped: owned.length }))
    await completed(command('thread_resume'))
    const crashTool = message(
      'Use the shell tool to run: printf started > baton-crash-started; sleep 120. Do not run any other command.',
    )
    await completed(crashTool)
    await waitFor(
      async () =>
        access(join(workspace, 'baton-crash-started')).then(
          () => true,
          () => false,
        ),
      Boolean,
    )
    const crashOwned = ownedProcesses()
    if (process.platform !== 'win32') assert.ok(crashOwned.length > 1)
    const beforeRestart = await history()
    const markerBeforeRestart = await stat(join(workspace, 'baton-crash-started'), { bigint: true })
    const previousWorkerPid = lastPid
    console.log(
      JSON.stringify({
        checkpoint: 'crash_process_ownership',
        processes: crashOwned.map((row) => ({
          pid: row.pid,
          parent: row.parent,
          group: row.group,
          state: row.state,
          program: row.command.split(/\s+/)[0],
        })),
      }),
    )
    process.kill(previousWorkerPid, 'SIGKILL')
    lastPid = undefined
    if (crashOwned.length)
      await waitFor(
        async () => snapshotProcesses(),
        (current) =>
          crashOwned.every(
            (prior) =>
              !current.some(
                (row) => row.pid === prior.pid && row.command === prior.command && !/^[ZX]/.test(row.state),
              ),
          ),
        5000,
      ).catch((error) => {
        console.error(
          JSON.stringify({
            checkpoint: 'crash_remaining_processes',
            processes: snapshotProcesses()
              .filter((row) => crashOwned.some((prior) => prior.pid === row.pid))
              .map((row) => ({
                pid: row.pid,
                parent: row.parent,
                group: row.group,
                state: row.state,
                program: row.command.split(/\s+/)[0],
              })),
          }),
        )
        throw error
      })
    console.log(
      JSON.stringify({ checkpoint: 'watchdog_after_worker_kill', capturedProcessesReaped: crashOwned.length }),
    )
    await delay(150)
    await host.ensureWorker(threadId)
    const restarted = await host.request(threadId, { type: 'status', ok: false })
    assert.notEqual(restarted.pid, previousWorkerPid)
    lastPid = restarted.pid
    await completed(command('thread_resume'))
    const restored = await readReports()
    assert.equal(restored.findLast((item) => item.kind === 'thread.resumed').native_session_id, nativeId)
    const afterRestart = await history()
    assert.deepEqual(afterRestart, beforeRestart)
    const mapping = JSON.parse(await readFile(join(data, 'threads', threadId, 'native.json'), 'utf8'))
    assert.equal(mapping.nativeSessionId, nativeId)
    const restoredInput = message('Reply with exactly BATON_CURSOR_RESTORED. Do not use tools or change files.')
    await completed(restoredInput)
    const restoredReplies = await turnEnded(restoredInput)
    assert.ok(
      restoredReplies.some(
        (item) =>
          item.kind === 'reply' &&
          item.client_message_id === restoredInput.client_message_id &&
          item.content?.includes('BATON_CURSOR_RESTORED'),
      ),
    )
    assert.equal(
      (await stat(join(workspace, 'baton-crash-started'), { bigint: true })).mtimeNs,
      markerBeforeRestart.mtimeNs,
      'Restoring the session must not execute the prior tool command again',
    )
    await completed(command('thread_stop'))
    console.log(
      JSON.stringify({
        passed: true,
        platform: `${process.platform}-${process.arch}`,
        sdk: '1.0.35',
        checks: [
          'authenticated_ipc',
          'multi_turn',
          'input_retry',
          'independent_history',
          'tool_cancel',
          'watchdog_after_worker_kill',
          'cross_process_resume',
          'resumed_execution',
          'no_tool_replay',
        ],
        workerReadyMs: readyMs,
        stopMs,
      }),
    )
  } finally {
    if (lastPid) {
      try {
        process.kill(lastPid, 'SIGTERM')
      } catch {}
      await delay(500)
      try {
        process.kill(lastPid, 'SIGKILL')
      } catch {}
    }
    // Failed validation retains private state locally for diagnosis when explicitly requested.
    if (process.argv.includes('--keep')) console.log(JSON.stringify({ privateData: root }))
    else await rm(root, { recursive: true, force: true })
  }
}
