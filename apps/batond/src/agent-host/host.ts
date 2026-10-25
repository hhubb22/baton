import { Console } from 'node:console'
import { Cause, Context, Effect, Exit, Fiber, Layer, Semaphore, Stream } from 'effect'
import { RpcServer, RpcSerialization } from 'effect/rpc'
import { NodeStdio } from '@effect/platform-node'
import { installHostProcessGroup } from '../platform/host-process-group.ts'
import { agentHostLayer, type AgentHostEnvironment, type AgentHostPaths } from './host-layer.ts'
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

export interface AgentHostOptions {
  readonly agentType: string
  readonly paths: AgentHostPaths
}

/**
 * One Agent host process: a POSIX process-group leader whose stdout carries
 * only RPC, whose Scope owns the Agent session, and whose child processes are
 * reaped with the group.
 */
export const runAgentHost = (module: AgentHostModule, options: AgentHostOptions) =>
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
    return yield* RpcServer.make(AgentHostRpc, { concurrency: 'unbounded', disableTracing: true }).pipe(
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
    const hosted = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideContext(context))
    const frames = driver.events.pipe(Stream.map((event): HostEvent => ({ generation, sequence: ++sequence, event })))
    yield* Effect.addFinalizer(() => hosted(driver.close).pipe(Effect.ignore))
    return AgentHostRpc.of({
      probe: () => regular.withPermit(hosted(driver.probe)),
      open: ({ config, generation: next }) =>
        regular.withPermit(
          hosted(driver.open({ config, generation: next })).pipe(
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
      send: ({ message, preparation }) => regular.withPermit(hosted(driver.send({ message, preparation }))),
      sent: ({ config, message, preparation }) =>
        regular.withPermit(
          hosted(driver.sent({ config, message, preparation })).pipe(Effect.map((value) => value ?? null)),
        ),
      events: () => Stream.unwrap(Effect.as(regular.take(1), frames.pipe(Stream.ensuring(regular.release(1))))),
      abort: () => control.withPermit(hosted(driver.abort)),
      close: () => control.withPermit(hosted(driver.close)),
    })
  })
