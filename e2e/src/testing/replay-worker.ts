import { existsSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Queue, Stream } from 'effect'
import type { AgentFactory, AgentEvent, AgentMessage, AgentEventIdentity } from '@baton/batond/worker/agent'
import { AgentError } from '@baton/batond/worker/agent'
import { makeOutputMailbox } from '@baton/batond/worker/output'
import { runWatchdogCommand } from '@baton/batond/platform/process'

type Input = { id: string; text: string; executionId: string }
// Derived from ThreadAgent's documented acceptance and event contract; no native service is called.
export const replay: AgentFactory = (config) => {
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
  throw new Error('Unsupported replay command')
}
if (process.argv[1] && /replay-worker\.(?:ts|cjs)$/.test(process.argv[1])) void main()
