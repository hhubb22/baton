import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Option, Schema, Semaphore, Tracer } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpTraceContext } from 'effect/http'
import { OtlpSerialization, OtlpTracer } from 'effect/observability'
import type { TraceData } from 'effect/observability/OtlpTracer'
import { TraceContext } from '@baton/protocol/trace'
import * as Statement from 'effect/sql/Statement'

export type { TraceContext } from '@baton/protocol/trace'

const TraceState = Context.Reference<string | undefined>('baton/telemetry/TraceState', {
  defaultValue: () => undefined,
})

export const decodeTrace = (input: unknown): TraceContext | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(TraceContext)(input))

export const traceFromHeaders = (headers: Record<string, string | undefined>): TraceContext | undefined =>
  decodeTrace({
    traceparent: headers.traceparent,
    ...(headers.tracestate ? { tracestate: headers.tracestate } : {}),
  })

export const captureTrace: Effect.Effect<TraceContext | undefined> = Effect.gen(function* () {
  const span = yield* Effect.currentSpan.pipe(Effect.option)
  if (Option.isNone(span)) return undefined
  const tracestate = yield* TraceState
  return {
    traceparent: HttpTraceContext.toHeaders(span.value).traceparent!,
    ...(tracestate ? { tracestate } : {}),
  }
})

export const traceParent = (input: unknown): Tracer.ExternalSpan | undefined => {
  const trace = decodeTrace(input)
  return trace ? Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(trace))) : undefined
}

/** Queue consumers use the durable producer as parent, including after restart. */
export const withTraceSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  name: string,
  input?: unknown,
  options: Tracer.SpanOptions = {},
): Effect.Effect<A, E, R> => {
  const trace = decodeTrace(input)
  const parent = traceParent(trace)
  const traced = Effect.withSpan(effect, name, { ...options, ...(parent ? { parent } : {}), captureStackTrace: false })
  return trace?.tracestate ? Effect.provideService(traced, TraceState, trace.tracestate) : traced
}

export const tracePromise = async <A>(
  tracer: Tracer.Tracer | undefined,
  name: string,
  trace: unknown,
  task: (context: TraceContext | undefined) => Promise<A>,
  options: Tracer.SpanOptions = {},
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    withTraceSpan(
      Effect.gen(function* () {
        const context = yield* captureTrace
        return yield* Effect.tryPromise({ try: () => task(context), catch: (error) => error })
      }),
      name,
      trace,
      options,
    ).pipe(Effect.provideService(Tracer.Tracer, tracer ?? Tracer.nativeTracer)),
  )
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return exit.value
}

const safeAttributes = new Set([
  'baton.command.id',
  'baton.thread.id',
  'baton.command.action',
  'baton.recovery',
  'baton.dispatch.accepted',
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'db.system.name',
  'db.operation.name',
  'effect.sql.method',
  'db.namespace',
  'db.client.connection.wait_time_ms',
  'server.address',
  'server.port',
  'error.type',
  'effect.fiber.interrupted',
])

/** Keep native spans and timings; redact payload-derived attributes, events and error details at export. */
const redact = (data: TraceData): TraceData => {
  for (const resource of data.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      for (let index = 0; index < scope.spans.length; index++) {
        const span = scope.spans[index]!
        scope.spans[index] = {
          ...span,
          attributes: span.attributes.filter(({ key }) => safeAttributes.has(key)),
          events: span.events
            .filter((event) => event.name.startsWith('effect.sql.transaction.'))
            .map((event) => ({ ...event, attributes: [] })),
          links: span.links.map((link) => ({ ...link, attributes: [] })),
          status: { code: span.status.code },
        }
      }
    }
  }
  return data
}

const privateSerialization = Layer.effect(
  OtlpSerialization.OtlpSerialization,
  Effect.gen(function* () {
    const json = yield* OtlpSerialization.OtlpSerialization
    return { ...json, traces: (data: TraceData) => json.traces(redact(data)) }
  }),
).pipe(Layer.provide(OtlpSerialization.layerJson))

const exportClient = (timeoutMs: number) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const scoped = HttpClient.withScope(client)
      const permits = yield* Semaphore.make(2)
      return HttpClient.makeWith(
        (request) =>
          Effect.scoped(scoped.postprocess(request).pipe(Effect.tap((result) => result.arrayBuffer))).pipe(
            Effect.timeout(timeoutMs),
            // The exporter catches defects and backs off; stalled or excess batches are not queued for retry.
            Effect.catchTag('TimeoutError', () => Effect.die(new Error('OTLP export request timed out'))),
            permits.withPermitsIfAvailable(1),
            Effect.flatMap((available) =>
              Option.isSome(available)
                ? Effect.succeed(available.value)
                : Effect.die(new Error('OTLP export capacity reached')),
            ),
          ),
        client.preprocess,
      )
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

/** OTLP/HTTP JSON is opt-in; requests and shutdown are capped at three seconds. */
export const telemetryLayer = (serviceName: string, env: Record<string, string | undefined> = process.env) => {
  const configuredTimeout = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT ?? 3000)
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout, 3000) : 3000
  const provider = ConfigProvider.fromEnv({
    env: {
      ...env,
      OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME || serviceName,
      OTEL_TRACES_EXPORTER: env.OTEL_TRACES_EXPORTER ?? 'otlp',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: String(timeoutMs),
    },
  })
  const exporter = OtlpTracer.layerFromConfig({
    resource: { attributes: { 'service.instance.id': `${serviceName}:${process.pid}`, 'process.pid': process.pid } },
  }).pipe(
    Layer.provide(privateSerialization),
    Layer.provide(exportClient(timeoutMs)),
    Layer.provide(ConfigProvider.layer(provider)),
  )
  return Layer.merge(exporter, Layer.succeed(Statement.SpanPropagationEnabled, true))
}
