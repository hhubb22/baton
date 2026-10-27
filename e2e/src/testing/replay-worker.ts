import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { telemetryLayer } from '@baton/telemetry'
import { Effect, Queue, Stream } from 'effect'
import type { AgentFactory, AgentEvent, AgentMessage, AgentEventIdentity } from '@baton/batond/worker/agent'
import { AgentError } from '@baton/batond/worker/agent'
import { makeOutputMailbox } from '@baton/batond/worker/output'
import { runWorker } from '@baton/batond/daemon/worker-runner'
import { runWatchdogCommand, startProcessWatchdog } from '@baton/batond/platform/process'
import { makeShellAgentFactory } from '@baton/batond/agents/shell/index'

type Input = { id: string; text: string; executionId: string }
// Derived from ThreadAgent's documented acceptance and event contract; no native service is called.
const replay: AgentFactory = (config) => {
  const events = Effect.runSync(Queue.unbounded<AgentEvent>())
  const output = makeOutputMailbox()
  const nativeSessionId = `replay-${config.thread_id}`
  const historyPath = join(config.working_directory, `${config.thread_id}.json`)
  const submissions = join(config.working_directory, 'submissions.jsonl')
  let active: AgentEventIdentity | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const io = <A>(task: () => Promise<A>) =>
    Effect.tryPromise({ try: task, catch: (cause) => new AgentError('Replay storage failed', cause) })
  const history = async (): Promise<Input[]> => {
    try {
      return JSON.parse(await readFile(historyPath, 'utf8')) as Input[]
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }
  const send = (message: AgentMessage) =>
    Effect.gen(function* () {
      const executionId = `execution-${message.id}`
      const entries = yield* io(history)
      yield* io(async () => {
        await writeFile(historyPath, JSON.stringify([...entries, { id: message.id, text: message.text, executionId }]))
        await appendFile(submissions, JSON.stringify({ id: message.id, text: message.text }) + '\n')
      })
      active = { nativeSessionId, messageId: message.id, executionId }
      const identity = active
      output.offer({ ...identity, text: `working:${message.text}\n` })
      const finish = () => {
        if (!active) return
        // hold 可由用例释放，当前回合自然结束时保留 Worker 内的排队输入。
        if (message.text === 'hold' && !existsSync(join(config.working_directory, `${config.thread_id}.release`))) {
          timer = setTimeout(finish, 25)
          return
        }
        Queue.offerUnsafe(events, {
          ...identity,
          type: 'reply',
          id: `reply-${message.id}`,
          text: `reply:${message.text}`,
        })
        Queue.offerUnsafe(events, { ...identity, type: 'end', outcome: 'completed' })
        active = undefined
      }
      timer = setTimeout(finish, 150)
      return { nativeSessionId, executionId }
    })
  const cancel = Effect.sync(() => {
    if (timer) clearTimeout(timer)
    if (active) Queue.offerUnsafe(events, { ...active, type: 'end', outcome: 'cancelled' })
    active = undefined
  })
  return {
    open: () => Effect.succeed({ nativeSessionId }),
    resume: () => Effect.succeed({ nativeSessionId }),
    prepareInput: (message, confirmedSends) =>
      Effect.succeed({
        nativeSessionId,
        preparationId: message.id,
        confirmedSends,
      }),
    restoreInput: () => Effect.void,
    send,
    sent: (message, preparation) =>
      io(async () => {
        const entries = await history()
        const input = entries
          .filter((_, index) => index >= preparation.confirmedSends)
          .find((item) => item.id === message.id)
        return input ? { nativeSessionId, executionId: input.executionId } : undefined
      }),
    events: Stream.fromQueue(events),
    output: output.stream,
    abort: () => cancel,
    close: () => cancel,
    reap: () => cancel.pipe(Effect.as({ processTreeStopped: true })),
  }
}

async function main() {
  if (process.argv[2] === 'watchdog') {
    await runWatchdogCommand()
    return
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { 'data-dir': { type: 'string' }, 'thread-id': { type: 'string' } },
  })
  if (!values['data-dir'] || !values['thread-id']) throw new Error('Missing replay Worker identity')
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  const dataDirectory = values['data-dir'],
    threadId = values['thread-id']
  const program = Effect.gen(function* () {
    const watchdog =
      process.platform === 'win32'
        ? undefined
        : yield* Effect.acquireRelease(
            Effect.promise(() =>
              startProcessWatchdog({ file: process.execPath, args: [process.argv[1]!, 'watchdog'] }),
            ),
            (owned) => Effect.promise(() => owned.close()),
          )
    const shell = makeShellAgentFactory({ dataDirectory, ...(watchdog ? { watchdog } : {}) })
    return yield* runWorker({
      dataDirectory,
      threadId,
      agentFactory: (config) => (config.agent_type === 'shell' ? shell(config) : replay(config)),
    })
  })
  try {
    await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(telemetryLayer('baton-worker'))), {
      signal: controller.signal,
    })
  } catch {
    if (!controller.signal.aborted) process.exitCode = 1
  }
}
void main()
