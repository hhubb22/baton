import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Queue, Stream } from 'effect'
import type { WorkerOpenConfig, FullOutputReference } from '@baton/protocol'
import { FullOutputStore, readOutputRetentionDays } from '../../worker/full-output.ts'
import {
  AgentError,
  type AgentEvent,
  type AgentFactory,
  type AgentMessage,
  type InputPreparation,
  type ThreadAgent,
} from '../../worker/agent.ts'
import { authorizeDirectory } from '../../daemon/roots.ts'
import { readProjectExec } from '../../devices/config.ts'
import { acquireProcessLock } from '../../platform/lock.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../../platform/private.ts'
import { spawnOwnedProcess, type OwnedProcess, type SpawnOwnedProcessOptions } from '../../platform/process.ts'
import { BoundedOutput } from './output.ts'
import {
  completionFor,
  loadCompletion,
  loadMapping,
  mappingFor,
  persistCompletion,
  persistMapping,
  prepare,
  readJson,
  statePath,
  submissionPath,
  validatePreparation,
  type ShellCompletion,
  type ShellMapping,
} from './evidence.ts'

export interface ShellAgentOptions extends Pick<SpawnOwnedProcessOptions, 'records' | 'watchdog'> {
  readonly dataDirectory: string
}

const missing = (cause: unknown): boolean => cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'

export const makeShellAgentFactory =
  (options: ShellAgentOptions): AgentFactory =>
  (config) =>
    makeShellAgent(config, options)

function makeShellAgent(config: WorkerOpenConfig, options: ShellAgentOptions): ThreadAgent {
  const events = Effect.runSync(Queue.bounded<AgentEvent>(8))
  const controller = new AbortController()
  let mapping: ShellMapping | undefined
  let prepared: InputPreparation | undefined
  let opening = false
  let opened = false
  let submitted = false
  let stopped = false
  let aborted = false
  let emitted = false
  let processTreeStopped = true
  let owned: OwnedProcess | undefined
  let startup: Promise<OwnedProcess> | undefined
  let finishing: Promise<void> | undefined
  const io = <A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, AgentError> =>
    Effect.tryPromise({
      try: work,
      catch: (cause) =>
        cause instanceof AgentError ? cause : new AgentError('shell state or execution operation failed', cause),
    })
  const emit = (event: AgentEvent): Promise<void> => Effect.runPromise(Queue.offer(events, event).pipe(Effect.asVoid))
  const native = async () => (mapping ??= await loadMapping(config))
  const emitCompletion = async (record: ShellCompletion) => {
    if (emitted) return
    emitted = true
    const identity = {
      nativeSessionId: record.mapping.nativeSessionId,
      messageId: record.messageId,
      executionId: record.executionId,
    }
    const reply: AgentEvent & {
      metadata: { exit_code: number; encoding?: string; full_output?: FullOutputReference }
      original_bytes: number
      truncated: boolean
    } = {
      ...identity,
      type: 'reply',
      id: `shell:${record.preparationId}`,
      text: record.result.output,
      metadata: {
        exit_code: record.result.exit_code,
        ...(record.result.full_output ? { full_output: record.result.full_output } : {}),
        ...(record.result.encoding ? { encoding: record.result.encoding } : {}),
      },
      original_bytes: record.result.total_bytes,
      truncated: record.result.truncated,
    }
    await emit(reply)
    if (record.completionKind === 'stopped')
      await emit({ type: 'uncertain', reason: 'shell command stopped; side effects are unknown' })
    else await emit({ ...identity, type: 'end', outcome: 'completed' })
  }
  const authorize = async () => {
    const cfg = await readProjectExec(options.dataDirectory)
    if (!cfg.enabled) throw new AgentError('此节点未开启 Project Agent 命令执行')
    const cwd = await authorizeDirectory(options.dataDirectory, config.working_directory)
    return { shell: cfg.shell, cwd }
  }
  const finish = async (
    process: OwnedProcess,
    message: AgentMessage,
    preparation: InputPreparation,
    output: BoundedOutput,
    retained: Awaited<ReturnType<FullOutputStore['begin']>>,
    pipes: Promise<unknown>,
    pipeFailed: () => boolean,
  ) => {
    try {
      const exit = await process.exited
      // A descendant may retain the pipes after the root exits. Bound draining, then reap the whole group.
      const drain = new AbortController()
      try {
        await Promise.race([pipes, delay(1000, undefined, { signal: drain.signal })])
      } finally {
        drain.abort()
      }
      const reaped = await process.reap()
      processTreeStopped = reaped.reaped
      if (!reaped.reaped || pipeFailed())
        throw new AgentError('shell output or process-tree termination could not be confirmed')
      const full_output = await retained.finish()
      const result = { ...output.result(exit.code ?? -1), full_output }
      const record = completionFor(mapping!, message, preparation, result, aborted)
      await persistCompletion(record)
      await emitCompletion(record)
    } catch {
      await emit({
        type: 'uncertain',
        reason: 'shell command completion could not be saved or verified; it will not be retried',
      })
    } finally {
      await retained.close()
    }
  }
  const agent: ThreadAgent = {
    open: (openConfig) =>
      io(async () => {
        if (opening || opened || stopped || JSON.stringify(openConfig) !== JSON.stringify(config))
          throw new AgentError('Invalid shell open lifecycle or configuration')
        opening = true
        try {
          const { cwd } = await authorize()
          controller.signal.throwIfAborted()
          try {
            await readJson(statePath(config), 16 * 1024)
            throw new AgentError('shell mapping already exists; creating another command is prohibited')
          } catch (cause) {
            if (!missing(cause)) throw cause
          }
          mapping = mappingFor(config, randomUUID(), cwd)
          await persistMapping(mapping)
          controller.signal.throwIfAborted()
          opened = true
          return { nativeSessionId: mapping.nativeSessionId }
        } finally {
          opening = false
        }
      }),
    resume: (nativeSessionId, openConfig) =>
      io(async () => {
        if (opening || opened || stopped || JSON.stringify(openConfig) !== JSON.stringify(config))
          throw new AgentError('Invalid shell restoration lifecycle or configuration')
        const saved = await native()
        const { cwd } = await authorize()
        if (saved.nativeSessionId !== nativeSessionId || saved.cwd !== cwd)
          throw new AgentError('shell restoration identity mismatch')
        try {
          await readJson(submissionPath(saved), 16 * 1024)
          throw new AgentError('shell execution was attempted; only completion evidence may be recovered')
        } catch (cause) {
          if (!missing(cause)) throw cause
        }
        controller.signal.throwIfAborted()
        opened = true
        return { nativeSessionId }
      }),
    prepareInput: (message, confirmedSends) =>
      io(async () => {
        if (!opened || stopped || submitted) throw new AgentError('shell Thread accepts only one command')
        prepared = prepare(message, await native(), confirmedSends)
        return prepared
      }),
    restoreInput: (message, preparation) =>
      io(async () => {
        // Only bind local evidence; sent performs the read-only filesystem lookup.
        if (JSON.stringify(preparation).length > 4096 || !message.id) throw new AgentError('Invalid shell preparation')
        prepared = preparation
      }),
    send: (message, preparation) =>
      io(async (signal) => {
        if (!opened || stopped || submitted) throw new AgentError('shell Thread accepts only one command')
        const nativeMapping = await native()
        validatePreparation(message, nativeMapping, preparation)
        if (JSON.stringify(prepared) !== JSON.stringify(preparation))
          throw new AgentError('shell input was not prepared')
        submitted = true
        const linked = AbortSignal.any([signal, controller.signal])
        const release = await acquireProcessLock(join(dirname(nativeMapping.statePath), 'shell-submit.lock'))
        try {
          try {
            await readJson(submissionPath(nativeMapping), 16 * 1024)
            throw new AgentError('shell execution was already attempted; automatic retry is prohibited')
          } catch (cause) {
            if (!missing(cause)) throw cause
          }
          const { shell, cwd } = await authorize()
          if (cwd !== nativeMapping.cwd || (await realpath(config.working_directory)) !== nativeMapping.cwd)
            throw new AgentError('shell working directory changed since open')
          linked.throwIfAborted()
          // This marker prevents another launch; only a real completion is recovery acceptance evidence.
          await writePrivateFileAtomic(
            submissionPath(nativeMapping),
            JSON.stringify({ preparationId: preparation.preparationId }),
          )
          linked.throwIfAborted()
          const threadDirectory = join(options.dataDirectory, 'threads', config.thread_id)
          await ensurePrivateDirectory(join(options.dataDirectory, 'threads'))
          await ensurePrivateDirectory(threadDirectory)
          const store = new FullOutputStore(threadDirectory)
          const retained = await store.begin(config, await readOutputRetentionDays(options.dataDirectory))
          const output = new BoundedOutput((bytes) => retained.write(bytes))
          let failed = false
          let pipes: Promise<unknown> = Promise.resolve()
          processTreeStopped = false
          startup = spawnOwnedProcess(
            {
              file: shell,
              args: process.platform === 'win32' ? ['-NoProfile', '-Command', message.text] : ['-lc', message.text],
              cwd,
            },
            {
              records: options.records,
              watchdog: options.watchdog,
              signal: linked,
              role: 'shell',
              onSpawn: (child) => {
                pipes = Promise.all(
                  [child.stdout, child.stderr].map(
                    (stream) =>
                      new Promise<void>((resolve) => {
                        stream.on('data', (chunk: Buffer) => output.write(chunk))
                        stream.once('end', resolve)
                        stream.once('close', resolve)
                        stream.once('error', () => {
                          failed = true
                          resolve()
                        })
                      }),
                  ),
                )
              },
            },
          )
          try {
            owned = await startup
          } catch (error) {
            await retained.close()
            throw error
          }
          owned.stdin.end()
          finishing = finish(owned, message, preparation, output, retained, pipes, () => failed)
          linked.throwIfAborted()
          return { nativeSessionId: nativeMapping.nativeSessionId, executionId: preparation.preparationId }
        } finally {
          await release()
        }
      }),
    sent: (message, preparation) =>
      io(async () => {
        const nativeMapping = await native()
        validatePreparation(message, nativeMapping, preparation)
        let record: ShellCompletion
        try {
          record = await loadCompletion(nativeMapping)
        } catch (cause) {
          if (missing(cause)) return undefined
          throw cause
        }
        if (
          record.messageId !== message.id ||
          record.preparationId !== preparation.preparationId ||
          record.executionId !== preparation.preparationId
        )
          throw new AgentError('shell completion input identity mismatch')
        await emitCompletion(record)
        return { nativeSessionId: nativeMapping.nativeSessionId, executionId: record.executionId }
      }),
    events: Stream.fromQueue(events),
    abort: () =>
      io(async () => {
        stopped = true
        aborted = true
        controller.abort()
        if (owned) processTreeStopped = (await owned.reap()).reaped
      }),
    close: () => agent.abort(),
    reap: () =>
      io(async () => {
        stopped = true
        if (!processTreeStopped) aborted = true
        controller.abort()
        if (startup) {
          try {
            owned = await startup
          } catch (cause) {
            processTreeStopped = !(cause instanceof AggregateError)
          }
        }
        if (owned) processTreeStopped = (await owned.reap()).reaped
        if (finishing) await finishing
        return { processTreeStopped }
      }),
  }
  return agent
}
