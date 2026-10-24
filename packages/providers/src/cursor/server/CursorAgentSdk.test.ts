import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { ProviderSessionId, ThreadId } from '../../upstream/contracts.ts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Fiber from 'effect/Fiber'
import { TestClock } from 'effect/testing'
import { makeBatonCursorAgentSdkRunner } from '../index.ts'
import { vi } from 'vite-plus/test'

import * as ProviderEventLoggers from '../../upstream/ProviderEventLoggers.ts'
import * as CursorAgentSdk from './CursorAgentSdk.ts'
import * as CursorSdk from './sdk-runtime.ts'

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = []
  const runOperations: Array<string> = []
  let agentCloseFailure: unknown
  let staleRunActive = false
  const runWait = vi.fn(async () => ({
    id: 'run-cursor-agent-sdk-test',
    requestId: 'request-cursor-agent-sdk-test',
    status: 'finished',
    result: 'ok',
    model: { id: 'default' },
    durationMs: 1,
  }))
  const runCancel = vi.fn(async () => {})
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push('sdk:agent.close')
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure
    }
  })
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push('run.start')
      if (staleRunActive) {
        throw new Error('Agent agent-cursor-agent-sdk-test already has active run')
      }
      await options.onDelta?.({
        update: {
          type: 'assistant-message-chunk',
          text: 'hello',
        },
      })
      return {
        id: 'run-cursor-agent-sdk-test',
        agentId: 'agent-cursor-agent-sdk-test',
        wait: runWait,
        cancel: runCancel,
      }
    },
  )
  const create = vi.fn(async (_options: unknown) => ({
    agentId: 'agent-cursor-agent-sdk-test',
    send,
    close: agentClose,
  }))
  const resume = vi.fn(async () => ({
    agentId: 'agent-cursor-agent-sdk-test',
    send,
    close: agentClose,
  }))
  const listRuns = vi.fn(async () => {
    runOperations.push('agent.listRuns')
    return {
      items: staleRunActive ? [{ id: 'run-stale', status: 'running' }] : [],
    }
  })
  const cancelRun = vi.fn(async () => {
    runOperations.push('agent.cancelRun')
    staleRunActive = false
  })

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active
    },
  }
})

vi.mock('./sdk.ts', () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: vi.fn(),
  SqliteLocalAgentStore: { open: vi.fn() },
}))

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: 'cursor-agent-sdk-test.log',
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === 'object' &&
              event !== null &&
              Reflect.get(Reflect.get(event, 'event'), 'payload')?.type === 'agent.close'
            ) {
              cursorSdkMock.closeExecutionOrder.push('protocol:agent.close')
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provideMerge(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
)

describe('CursorAgentSdkRunner', () => {
  it.effect.each(['before-handle', 'after-handle'])('bounds pending deltas %s', (phase) =>
    Effect.gen(function* () {
      const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined)
      const session = yield* runner.open({
        operation: 'create',
        options: { local: { cwd: process.cwd() } },
        threadId: ThreadId.make('overflow'),
        providerSessionId: ProviderSessionId.make('overflow'),
      })
      let emit: (input: { readonly update: unknown }) => Promise<void> = async () => {
        throw new Error('No SDK callback registered')
      }
      cursorSdkMock.send.mockImplementationOnce(async (_message, options) => {
        if (!options.onDelta) throw new Error('Missing SDK callback')
        emit = options.onDelta
        if (phase === 'before-handle') {
          for (let i = 0; i <= CursorAgentSdk.MAX_CURSOR_PENDING_UPDATES; i++)
            await emit({ update: { type: 'text-delta', text: 'delta' } })
        }
        return {
          id: 'overflow-run',
          agentId: 'agent-cursor-agent-sdk-test',
          wait: cursorSdkMock.runWait,
          cancel: cursorSdkMock.runCancel,
        }
      })
      const sending = session.send({ message: 'one input' })
      if (phase === 'before-handle') {
        assert.equal((yield* sending.pipe(Effect.flip)).method, 'run.onDelta')
      } else {
        const run = yield* sending
        yield* Effect.promise(async () => {
          const callbacks = Array.from({ length: CursorAgentSdk.MAX_CURSOR_PENDING_UPDATES + 1 }, () =>
            emit({ update: { type: 'text-delta', text: 'delta' } }),
          )
          await Promise.all(callbacks)
        })
        assert.equal((yield* run.wait.pipe(Effect.flip)).method, 'run.onDelta')
      }
    }).pipe(Effect.provide(CursorSdk.layer)),
  )
  it.effect('uses explicit credentials and disables SDK retries before creating an agent', () =>
    Effect.gen(function* () {
      const runner = yield* makeBatonCursorAgentSdkRunner()
      const base = {
        operation: 'create' as const,
        threadId: ThreadId.make('thread-policy'),
        providerSessionId: ProviderSessionId.make('session-policy'),
      }
      cursorSdkMock.create.mockClear()
      const error = yield* runner.open({ ...base, options: { local: { cwd: process.cwd() } } }).pipe(Effect.flip)
      assert.equal(error.method, 'agent.open')
      assert.equal(cursorSdkMock.create.mock.calls.length, 0)
      const session = yield* runner.open({
        ...base,
        options: {
          apiKey: 'explicit-test-key',
          local: {
            cwd: process.cwd(),
            enableAgentRetries: true,
            autoReview: false,
            sandboxOptions: { enabled: false },
          },
        },
      })
      assert.deepStrictEqual(cursorSdkMock.create.mock.calls[0], [
        {
          apiKey: 'explicit-test-key',
          local: { cwd: process.cwd(), enableAgentRetries: false, autoReview: true, sandboxOptions: { enabled: true } },
        },
      ])
      cursorSdkMock.agentClose.mockClear()
      yield* session.close
      yield* session.close
      assert.equal(cursorSdkMock.agentClose.mock.calls.length, 1)
    }).pipe(Effect.provide(CursorSdk.layer)),
  )

  it.effect('keeps wait pending after cancel until the SDK reports termination', () =>
    Effect.gen(function* () {
      const runner = yield* makeBatonCursorAgentSdkRunner()
      const session = yield* runner.open({
        operation: 'create',
        options: { apiKey: 'explicit-test-key', local: { cwd: process.cwd() } },
        threadId: ThreadId.make('thread-cancel'),
        providerSessionId: ProviderSessionId.make('session-cancel'),
      })
      type Result = Awaited<ReturnType<typeof cursorSdkMock.runWait>>
      let finish: (result: Result) => void = () => {
        throw new Error('Wait not registered')
      }
      cursorSdkMock.runWait.mockReturnValueOnce(
        new Promise<Result>((resolve) => {
          finish = resolve
        }),
      )
      const run = yield* session.send({ message: 'single input' })
      const waiting = yield* run.wait.pipe(Effect.forkChild({ startImmediately: true }))
      cursorSdkMock.runCancel.mockClear()
      yield* run.cancel
      yield* run.cancel
      assert.equal(cursorSdkMock.runCancel.mock.calls.length, 1)
      yield* TestClock.adjust('61 seconds')
      assert.isUndefined(waiting.pollUnsafe())
      finish({
        id: run.runId,
        requestId: 'request',
        status: 'cancelled',
        result: '',
        model: { id: 'default' },
        durationMs: 1,
      })
      const result = yield* Fiber.join(waiting)
      assert.equal(result.status, 'cancelled')
    }).pipe(Effect.provide(layerTest)),
  )
  it.effect('returns a resumed send conflict without cancelling or resubmitting', () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0
      cursorSdkMock.listRuns.mockClear()
      cursorSdkMock.cancelRun.mockClear()
      cursorSdkMock.setStaleRunActive(true)

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner
      const session = yield* runner.open({
        operation: 'resume',
        agentId: 'agent-cursor-agent-sdk-test',
        options: { model: { id: 'default' }, mode: 'agent', local: { cwd: process.cwd() } },
        threadId: ThreadId.make('thread-cursor-agent-sdk-stale-run-test'),
        providerSessionId: ProviderSessionId.make('provider-session-cursor-agent-sdk-stale-run-test'),
      })
      assert.deepStrictEqual(cursorSdkMock.runOperations, [])
      const error = yield* session.send({ message: 'continue' }).pipe(Effect.flip)
      assert.equal(error.method, 'run.start')
      assert.deepStrictEqual(cursorSdkMock.runOperations, ['run.start'])
      assert.equal(cursorSdkMock.listRuns.mock.calls.length, 0)
      assert.equal(cursorSdkMock.cancelRun.mock.calls.length, 0)
      cursorSdkMock.setStaleRunActive(false)
    }).pipe(Effect.provide(layerTest)),
  )
})
