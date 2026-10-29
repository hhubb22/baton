import { Console } from 'node:console'
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Option, Semaphore, Stream, Tracer } from 'effect'
import { RpcServer, RpcSerialization } from 'effect/rpc'
import { NodeStdio } from '@effect/platform-node'
import { installHostProcessGroup } from '../platform/host-process-group.ts'
import { agentHostLayer, type AgentHostEnvironment } from './host-layer.ts'
import type { AgentHostPaths } from './paths.ts'
import { makeProcessRegistrar } from './process-registrar.ts'
import {
  AgentHostDriver,
  AgentHostError,
  AgentHostProcessGroup,
  AgentHostRpc,
  type AgentHostDriverShape,
  type HostEvent,
} from './protocol.ts'

export interface AgentHostModule {
  readonly driver: (input: {
    readonly agentType: string
    readonly paths: AgentHostPaths
  }) => Layer.Layer<AgentHostDriver, unknown, AgentHostEnvironment>
  /**
   * Cursor folds detached SDK children into the host group. Agents that signal
   * their own process group, such as Pi, leave `foldDetached` false.
   */
  readonly foldDetached?: boolean
  /** Inner process spawner. Production uses Node; replay passes an upstream testkit. */
  readonly spawner?: Parameters<typeof agentHostLayer>[0]['spawner']
}

export interface HostRunOptions {
  readonly agentType: string
  readonly paths: AgentHostPaths
}

/**
 * One Agent host process: a POSIX process-group leader whose stdout carries
 * only RPC, whose Scope owns the Agent session, and whose child processes are
 * reaped with the group.
 */
export const runAgentHost = (module: AgentHostModule, options: HostRunOptions) =>
  Effect.gen(function* () {
    if (process.platform !== 'win32') process.umask(0o077)
    const originalConsole = globalThis.console
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.console = originalConsole
      }),
    )
    const processGroup = yield* Effect.sync(() =>
      installHostProcessGroup({ foldDetached: module.foldDetached !== false }),
    )
    const registrar = yield* makeProcessRegistrar()
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* registrar.close
        // The host group covers every child that inherited it; a late SDK spawn is refused.
      }),
    )
    const processGroupLayer = Layer.succeed(
      AgentHostProcessGroup,
      AgentHostProcessGroup.of({
        terminateChildren: processGroup
          .terminateChildrenEffect()
          .pipe(Effect.mapError(() => new AgentHostError({ message: 'Agent host children could not be terminated' }))),
        waitQuiescent: (timeoutMs) =>
          processGroup
            .waitQuiescentEffect({ timeoutMs })
            .pipe(Effect.mapError(() => new AgentHostError({ message: 'Agent host children are not quiescent' }))),
      }),
    )
    const environment = yield* Layer.build(
      module.driver({ agentType: options.agentType, paths: options.paths }).pipe(
        Layer.provide(
          Layer.mergeAll(
            agentHostLayer({
              paths: options.paths,
              registrar,
              ...(module.spawner ? { spawner: module.spawner } : {}),
            }),
            processGroupLayer,
          ),
        ),
      ),
    )
    const driver = yield* AgentHostDriver.pipe(Effect.provideContext(environment))
    const handlers = yield* makeAgentHostHandlers(driver, environment)
    return yield* RpcServer.make(AgentHostRpc, { concurrency: 'unbounded' }).pipe(
      Effect.provide(AgentHostRpc.toLayer(handlers)),
      Effect.provide(RpcServer.layerProtocolStdio),
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provide(NodeStdio.layer),
      Effect.forkScoped,
      Effect.flatMap(Fiber.await),
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.failCause(exit.cause) : Effect.void,
      ),
    )
  })

const makeAgentHostHandlers = <Services>(driver: AgentHostDriverShape, context: Context.Context<Services>) =>
  Effect.gen(function* () {
    const regular = Semaphore.makeUnsafe(7)
    const control = Semaphore.makeUnsafe(1)
    let generation = ''
    let sequence = 0
    const clock = yield* Clock.Clock
    const tracer = yield* Tracer.Tracer
    const turns = new Map<string, Tracer.Span>()
    const hosted = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideContext(context))
    const frames = driver.events.pipe(
      Stream.map((event): HostEvent => {
        if (event.type === 'model') turns.get(event.messageId)?.attribute('gen_ai.request.model', event.model)
        if (event.type === 'item') {
          const parent = turns.get(event.messageId)
          const kinds: Record<string, string> = {
            command_execution: 'command',
            file_change: 'file_change',
            mcp_tool_call: 'mcp',
            web_search: 'web',
            tool_call: 'other',
          }
          const kind = kinds[event.item.type]
          if (parent && (kind || event.item.type === 'approval_request')) {
            const start = Date.parse(event.item.started_at ?? '')
            const end = Date.parse(event.item.completed_at ?? '')
            const now = clock.currentTimeNanosUnsafe()
            const endTime = Number.isFinite(end) ? BigInt(end) * 1_000_000n : now
            const startTime = Number.isFinite(start) ? BigInt(start) * 1_000_000n : endTime
            const span = tracer.span({
              name: kind ? 'baton.agent.tool' : 'baton.agent.approval',
              parent: Option.some(parent),
              annotations: Context.empty(),
              links: [],
              startTime: startTime < endTime ? startTime : endTime,
              kind: 'internal',
              root: false,
              sampled: parent.sampled,
            })
            if (kind) span.attribute('baton.tool.kind', kind)
            span.end(endTime, event.item.status === 'failed' ? Exit.fail('tool_failed') : Exit.void)
          }
        }
        if (event.type === 'end') {
          const span = turns.get(event.messageId)
          if (span) {
            span.attribute('baton.turn.result', event.outcome === 'cancelled' ? 'stopped' : event.outcome)
            span.end(clock.currentTimeNanosUnsafe(), event.outcome === 'failed' ? Exit.fail('turn_failed') : Exit.void)
            turns.delete(event.messageId)
          }
        }
        return { generation, sequence: ++sequence, event }
      }),
    )
    yield* Effect.addFinalizer(() => hosted(driver.close).pipe(Effect.ignore))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const span of turns.values()) {
          span.attribute('baton.turn.result', 'lost')
          span.end(clock.currentTimeNanosUnsafe(), Exit.void)
        }
        turns.clear()
      }),
    )
    return AgentHostRpc.of({
      probe: () => regular.withPermit(hosted(driver.probe)),
      open: ({ config, generation: next }) =>
        regular.withPermit(
          hosted(driver.open({ config, generation: next })).pipe(
            Effect.withSpan('baton.agent.session', { attributes: { 'baton.recovery': false } }),
            Effect.tap((identity) =>
              Effect.sync(() => {
                generation = next
                sequence = 0
                return identity
              }),
            ),
          ),
        ),
      resume: ({ config, generation: next, nativeSessionId }) =>
        regular.withPermit(
          hosted(driver.resume({ config, generation: next, nativeSessionId })).pipe(
            Effect.withSpan('baton.agent.session', { attributes: { 'baton.recovery': true } }),
            Effect.tap((identity) =>
              Effect.sync(() => {
                generation = next
                sequence = 0
                return identity
              }),
            ),
          ),
        ),
      answer: ({ answer }) =>
        regular.withPermit(
          driver.answer
            ? hosted(driver.answer(answer))
            : Effect.fail(new AgentHostError({ message: 'Agent does not support answering questions' })),
        ),
      send: ({ message, preparation }) =>
        regular.withPermit(
          Effect.gen(function* () {
            if (message.mode === 'queue') {
              const span = yield* Effect.makeSpan('baton.agent.turn')
              turns.set(message.id, span)
            }
            return yield* hosted(driver.send({ message, preparation })).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  const span = turns.get(message.id)
                  if (span) {
                    span.attribute('baton.turn.result', 'failed')
                    span.end(clock.currentTimeNanosUnsafe(), Exit.void)
                    turns.delete(message.id)
                  }
                }),
              ),
            )
          }),
        ),
      sent: ({ config, message, preparation }) =>
        regular.withPermit(
          hosted(driver.sent({ config, message, preparation })).pipe(Effect.map((value) => value ?? null)),
        ),
      events: () => Stream.unwrap(Effect.as(regular.take(1), frames.pipe(Stream.ensuring(regular.release(1))))),
      flushEvents: ({ id }) => regular.withPermit(hosted(driver.flushEvents(id))),
      abort: () => control.withPermit(hosted(driver.abort)),
      close: () => control.withPermit(hosted(driver.close)),
    })
  })
