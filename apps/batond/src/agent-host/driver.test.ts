import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Fiber, Queue, Schema, Stream } from 'effect'
import { expect, it } from 'vite-plus/test'
import { OrchestrationV2ProviderThread, ProviderInstanceId } from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from '@t3tools/provider-core/server/ProviderAdapter'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeProviderHostDriver } from './driver.ts'
import { AgentHostProcessGroup, type ExecutionEvent } from './protocol.ts'

const now = '2026-01-01T00:00:00.000Z'
const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(ProviderAdapterV2Event))

it.each([false, true])(
  'deduplicates terminal items and flushes latest unfinished items before end (abort=%s)',
  async (abort) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(() => makePrivateTempDirectory('baton-driver-items-')),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          )
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>()
          const instanceId = ProviderInstanceId.make('pi-test')
          const thread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ProviderThread))({
            id: 'provider-thread',
            driver: 'pi',
            providerInstanceId: instanceId,
            providerSessionId: 'session',
            appThreadId: 'thread',
            ownerNodeId: null,
            nativeThreadRef: { driver: 'pi', strength: 'strong', nativeId: 'native' },
            nativeConversationHeadRef: null,
            status: 'idle',
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          })
          let input!: ProviderAdapterV2TurnInput
          const providerTurn = (usage: number, status = 'running') =>
            decodeEvent({
              type: 'provider_turn.updated',
              driver: 'pi',
              providerTurn: {
                id: 'provider-turn',
                providerThreadId: thread.id,
                nodeId: 'node',
                runAttemptId: input.attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: null,
                tokenUsage: { usedTokens: usage, inputTokens: 10, outputTokens: usage - 10, updatedAt: now },
              },
            })
          // Only the runtime operations exercised by the driver are provided by this local event source.
          const runtime = {
            events: Stream.fromQueue(events),
            ensureThread: () => Effect.succeed(thread),
            startTurn: (next: ProviderAdapterV2TurnInput) =>
              Effect.gen(function* () {
                input = next
                yield* Queue.offer(events, providerTurn(20))
              }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime
          const driver = yield* makeProviderHostDriver({
            label: 'Pi',
            instanceId,
            adapter: { openSession: () => Effect.succeed(runtime) } as unknown as ProviderAdapterV2['Service'],
            steer: true,
            interactionMode: 'default',
            model: () => ({ instanceId, model: 'default', options: [{ id: 'serviceTier', value: 'fast' }] }),
            probe: Effect.succeed({ authenticated: 'valid', models: [], details: {} }),
          }).pipe(
            Effect.provide(IdAllocator.layer),
            Effect.provideService(AgentHostProcessGroup, {
              terminateChildren: Effect.void,
              waitQuiescent: () => Effect.void,
            }),
          )
          const config: WorkerOpenConfig = {
            thread_id: randomUUID(),
            node_id: randomUUID(),
            storage_generation: randomUUID(),
            agent_type: 'pi',
            runtime_mode: 'full-access',
            working_directory: root,
            execution_timeout_seconds: 60,
            adapter_config: { state_path: join(root, 'native.json') },
          }
          yield* driver.open({ config, generation: 'generation' })
          const conflict = yield* Effect.flip(
            driver.sent({
              config: { ...config, runtime_mode: 'approval-required' },
              message: { id: 'message', text: 'run', epoch: 0, operationId: 'operation', mode: 'queue' },
              preparation: { nativeSessionId: 'native', preparationId: 'prepared', confirmedSends: 0 },
            }),
          )
          expect(conflict.message).toBe('runtime_mode_conflict')
          const received: ExecutionEvent[] = []
          const collector = yield* driver.events.pipe(
            Stream.takeUntil((event) => event.type === 'end'),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                received.push(event)
              }),
            ),
            Effect.forkChild,
          )
          yield* driver.send({
            message: {
              id: 'message',
              text: 'run',
              epoch: 0,
              operationId: 'operation',
              mode: 'queue',
              thinking: { id: 'thinking', value: 'high' },
            },
            preparation: { nativeSessionId: 'native', preparationId: 'prepared', confirmedSends: 0 },
          })
          expect(input.modelSelection.options).toEqual([
            { id: 'serviceTier', value: 'fast' },
            { id: 'thinking', value: 'high' },
          ])
          expect(input.appThread.modelSelection.options).toEqual(input.modelSelection.options)
          expect(input.runtimePolicy).toEqual({ cwd: root, runtimeMode: 'full-access', interactionMode: 'default' })
          expect(input.appThread.runtimeMode).toBe('full-access')
          const item = (
            id: string,
            status: string,
            ordinal: number,
            output = '',
            runId = input.runId,
            type = 'command_execution',
          ) =>
            decodeEvent({
              type: 'turn_item.updated',
              driver: 'pi',
              turnItem: {
                id,
                type,
                createdBy: 'user',
                creationSource: 'server',
                workflowScript: null,
                inputIntent: 'turn_start',
                attachments: [],
                messageId: 'assistant',
                text: 'reply',
                streaming: false,
                threadId: config.thread_id,
                runId,
                nodeId: null,
                providerThreadId: thread.id,
                providerTurnId: 'provider-turn',
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status,
                title: id,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                input: 'pwd',
                output,
              },
            })
          yield* Queue.offer(events, item('finished', 'running', 0, 'old'))
          while (
            !received.some(
              (event) => event.type === 'running_steps' && event.steps.some((step) => step.item_id === 'finished'),
            )
          )
            yield* Effect.yieldNow
          yield* Queue.offer(events, item('late', 'running', 9, 'old'))
          yield* Queue.offer(events, item('early', 'waiting', 2, 'waiting'))
          yield* Queue.offer(events, item('finished', 'completed', 0, 'first terminal'))
          while (!received.some((event) => event.type === 'item' && event.item.id === 'finished'))
            yield* Effect.yieldNow
          while (
            !received.some(
              (event) =>
                event.type === 'running_steps' &&
                event.steps.some((step) => step.item_id === 'late') &&
                !event.steps.some((step) => step.item_id === 'finished'),
            )
          )
            yield* Effect.yieldNow
          yield* Queue.offer(events, item('finished', 'failed', 0, 'ignored terminal'))
          yield* Queue.offer(events, item('late', 'running', 9, 'latest'))
          yield* Queue.offer(events, item('foreign', 'completed', 3, '', 'other-run' as typeof input.runId))
          yield* Queue.offer(events, item('assistant', 'completed', 4, '', input.runId, 'assistant_message'))
          yield* Queue.offer(events, item('user', 'completed', 5, '', input.runId, 'user_message'))
          yield* Queue.offer(events, providerTurn(35, 'completed'))
          if (abort) {
            while ((yield* Queue.size(events)) > 0) yield* Effect.yieldNow
            yield* driver.abort
            yield* driver.flushEvents('durable-stop')
          }
          yield* Queue.offer(
            events,
            decodeEvent({
              type: 'turn.terminal',
              driver: 'pi',
              providerThreadId: thread.id,
              providerTurnId: 'provider-turn',
              runOrdinal: 1,
              status: abort ? 'interrupted' : 'completed',
              failure: null,
              threadDisposition: 'reusable',
            }),
          )
          yield* Fiber.join(collector)
          expect(received.filter((event) => event.type !== 'running_steps').map((event) => event.type)).toEqual(
            abort ? ['item', 'item', 'item', 'barrier', 'end'] : ['item', 'item', 'item', 'end'],
          )
          expect(
            received
              .filter((event) => event.type === 'item')
              .map((event) => [event.item.id, event.item.status, event.item.data]),
          ).toMatchObject([
            ['finished', 'completed', { output: 'first terminal', startedAt: now }],
            ['early', 'waiting', { output: 'waiting' }],
            ['late', 'running', { output: 'latest' }],
          ])
          expect(received.at(-1)).toMatchObject({ type: 'end', tokenUsage: { usedTokens: 35, outputTokens: 25 } })
        }),
      ).pipe(Effect.timeout('10 seconds')),
    )
  },
)
