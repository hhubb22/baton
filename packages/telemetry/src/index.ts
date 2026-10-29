import { Cause, Clock, ConfigProvider, Context, Effect, Exit, Layer, Option, Schema, Semaphore, Tracer } from 'effect'
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpTraceContext,
} from 'effect/http'
import { OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpTracer } from 'effect/observability'
import { BUILD } from '@baton/protocol/release.mjs'
import { MaxMessageBytes } from '@baton/protocol'
import type { TraceData } from 'effect/observability/OtlpTracer'
import type { KeyValue } from 'effect/observability/OtlpResource'
import { TraceContext } from '@baton/protocol/trace'
import * as Statement from 'effect/sql/Statement'
import { safeAttributes } from './attributes.js'
import { metricNames, metricValues } from './metrics.js'
import { otlpTimeout, otlpTimeouts } from './otlp-config.js'

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

export const waitEvent = (
  phase: 'start' | 'end',
  reason: 'device_offline' | 'approval' | 'credential_missing' | 'queue' | 'lease' | 'backoff',
  attributes: Record<string, string | number>,
  trace?: unknown,
  durationMs?: number,
) =>
  withTraceSpan(
    Effect.logInfo(`baton.wait.${phase}`).pipe(
      Effect.annotateLogs({
        ...attributes,
        'baton.wait.reason': reason,
        ...(durationMs === undefined ? {} : { 'baton.wait.duration_ms': Math.max(0, durationMs) }),
      }),
    ),
    'baton.wait',
    trace,
  ).pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))

/** Queue consumers use the durable producer as parent, including after restart. */
export const withTraceSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  name: string,
  input?: unknown,
  options: Tracer.SpanOptions = {},
): Effect.Effect<A, E, R> => {
  const trace = decodeTrace(input)
  const parent = traceParent(trace)
  const traced = Effect.withSpan(effect, name, {
    ...options,
    ...(!options.parent && parent ? { parent } : {}),
    captureStackTrace: false,
  })
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

/** Keep native spans and timings; redact payload-derived attributes, events and error details at export. */
const safeResource = (attributes: KeyValue[], nodeId?: string) =>
  attributes.filter(
    ({ key, value }) =>
      safeAttributes.has(key) &&
      key !== 'rum.sessionId' &&
      (key !== 'baton.node.id' || (nodeId !== undefined && value.stringValue === nodeId)),
  )
const redact = (data: TraceData, nodeId?: string): TraceData => {
  for (const resource of data.resourceSpans) {
    resource.resource.attributes = safeResource(resource.resource.attributes, nodeId)
    for (const scope of resource.scopeSpans) {
      for (let index = 0; index < scope.spans.length; index++) {
        const span = scope.spans[index]!
        scope.spans[index] = {
          ...span,
          attributes: span.attributes
            .filter(({ key }) => safeAttributes.has(key) && key !== 'rum.sessionId')
            .filter(
              ({ key }) =>
                !span.attributes.some(
                  (attribute) => attribute.key === 'baton.usage.reported' && attribute.value.boolValue === false,
                ) ||
                ![
                  'gen_ai.usage.input_tokens',
                  'gen_ai.usage.output_tokens',
                  'baton.usage.cached_input_tokens',
                ].includes(key),
            ),
          events: span.events
            .filter((event) =>
              [
                'effect.sql.transaction.commit',
                'effect.sql.transaction.rollback',
                'effect.sql.transaction.savepoint',
              ].includes(event.name),
            )
            .map((event) => ({ ...event, attributes: [] })),
          links: span.links.map((link) => ({ ...link, attributes: [] })),
          status: { code: span.status.code },
        }
      }
    }
  }
  return data
}

const privateSerialization = (nodeId?: string) =>
  Layer.effect(
    OtlpSerialization.OtlpSerialization,
    Effect.gen(function* () {
      const json = yield* OtlpSerialization.OtlpSerialization
      return {
        traces: (data: TraceData) => json.traces(redact(data, nodeId)),
        logs: (data: Parameters<typeof json.logs>[0]) => {
          for (const resource of data.resourceLogs) {
            if (resource.resource) resource.resource.attributes = safeResource(resource.resource.attributes, nodeId)
            for (const scope of resource.scopeLogs) {
              if (scope.scope) scope.scope.attributes = []
              if (scope.logRecords)
                scope.logRecords = scope.logRecords
                  .filter(
                    (record) =>
                      record.body?.stringValue === 'baton.wait.start' || record.body?.stringValue === 'baton.wait.end',
                  )
                  .map((record) => ({
                    ...record,
                    attributes: record.attributes.filter(
                      ({ key }) => safeAttributes.has(key) && key !== 'rum.sessionId',
                    ),
                  }))
            }
          }
          return json.logs(data)
        },
        metrics: (data: Parameters<typeof json.metrics>[0]) => {
          for (const resource of data.resourceMetrics) {
            resource.resource.attributes = safeResource(resource.resource.attributes, nodeId)
            for (const scope of resource.scopeMetrics) {
              scope.scope.attributes = []
              scope.metrics = scope.metrics.filter((metric) => metricNames.has(metric.name))
              for (const metric of scope.metrics) {
                delete metric.description
                for (const aggregation of [
                  metric.gauge,
                  metric.sum,
                  metric.histogram,
                  metric.exponentialHistogram,
                  metric.summary,
                ]) {
                  if (!aggregation) continue
                  for (const point of aggregation.dataPoints) {
                    point.attributes =
                      point.attributes?.filter(
                        ({ key, value }) =>
                          safeAttributes.has(key) &&
                          typeof value.stringValue === 'string' &&
                          metricValues[key]?.has(value.stringValue),
                      ) ?? []
                    if ('exemplars' in point) point.exemplars = []
                  }
                }
              }
            }
          }
          return json.metrics(data)
        },
      }
    }),
  ).pipe(Layer.provide(OtlpSerialization.layerJson))

export interface LocalTelemetry {
  endpoint: string
  headers: string
}

export const telemetryEnvironment = (local?: LocalTelemetry): Record<string, string | undefined> => {
  if (!local || Object.keys(process.env).some((key) => key.startsWith('OTEL_EXPORTER_OTLP_'))) return {}
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: local.endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: local.headers,
    BATON_TELEMETRY_LOCAL_RELAY: '1',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: String(
      Math.max(1, Math.floor(Math.min(64, Number(process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE) || 64))),
    ),
    OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: String(
      Math.max(1, Math.floor(Math.min(64, Number(process.env.OTEL_BLRP_MAX_EXPORT_BATCH_SIZE) || 64))),
    ),
  }
}

const exportClient = (timeouts: Record<string, number>, localRelay: boolean) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const scoped = HttpClient.withScope(client)
      const permits = yield* Semaphore.make(2)
      const clock = yield* Clock.Clock
      let suspendedUntil = 0
      return HttpClient.makeWith<HttpClientError.HttpClientError, never, HttpClientError.HttpClientError, never>(
        (request) =>
          Effect.suspend(() =>
            clock.currentTimeMillisUnsafe() < suspendedUntil
              ? Effect.die(new Error('OTLP export paused'))
              : Effect.flatMap(request, (original) => {
                  if (
                    localRelay &&
                    original.body._tag === 'Uint8Array' &&
                    original.body.body.byteLength > MaxMessageBytes - 1024
                  )
                    return Effect.succeed(HttpClientResponse.fromWeb(original, new Response(null, { status: 200 })))
                  return Effect.scoped(
                    scoped.postprocess(Effect.succeed(original)).pipe(
                      Effect.tap((result) => result.arrayBuffer),
                      Effect.flatMap((result) =>
                        result.status >= 200 && result.status < 300
                          ? Effect.succeed(result)
                          : Effect.die(new Error('OTLP export failed')),
                      ),
                      Effect.catch(() => Effect.die(new Error('OTLP export failed'))),
                    ),
                  ).pipe(
                    Effect.timeout(timeouts[original.url] ?? 3000),
                    // The exporter catches defects and backs off; stalled or excess batches are not queued for retry.
                    Effect.catchTag('TimeoutError', () => Effect.die(new Error('OTLP export request timed out'))),
                    permits.withPermitsIfAvailable(1),
                    Effect.flatMap((available) =>
                      Option.isSome(available)
                        ? Effect.succeed(available.value)
                        : Effect.die(new Error('OTLP export capacity reached')),
                    ),
                    Effect.tapCause(() =>
                      Effect.sync(() => {
                        suspendedUntil = clock.currentTimeMillisUnsafe() + 60_000
                      }),
                    ),
                  )
                }),
          ),
        client.preprocess,
      )
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

/** OTLP/HTTP JSON is opt-in; requests and shutdown are capped at three seconds. */
export const telemetryLayer = (serviceName: string, env: Record<string, string | undefined> = process.env) => {
  const exporterEnv = { ...env }
  const timeoutFor = (signal: 'TRACES' | 'LOGS' | 'METRICS') => otlpTimeout(env, signal)
  const timeouts = otlpTimeouts(env, exporterEnv)
  const provider = ConfigProvider.fromEnv({
    env: {
      ...exporterEnv,
      OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME || serviceName,
      OTEL_TRACES_EXPORTER: env.OTEL_TRACES_EXPORTER ?? 'otlp',
      OTEL_LOGS_EXPORTER: env.OTEL_LOGS_EXPORTER ?? 'otlp',
      OTEL_METRICS_EXPORTER: env.OTEL_METRICS_EXPORTER ?? 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: env.OTEL_METRIC_EXPORT_INTERVAL ?? '30000',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: String(timeoutFor('TRACES')),
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: String(timeoutFor('LOGS')),
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: String(timeoutFor('METRICS')),
    },
  })
  const nodeId =
    serviceName !== 'baton-server' &&
    env.BATON_TELEMETRY_NODE_ID &&
    /^[0-9a-f-]{36}$/i.test(env.BATON_TELEMETRY_NODE_ID)
      ? env.BATON_TELEMETRY_NODE_ID
      : undefined
  const resource = {
    serviceName,
    serviceVersion: BUILD.version,
    attributes: {
      'vcs.ref.head.revision': BUILD.commit,
      'service.instance.id': `${serviceName}:${process.pid}`,
      'process.pid': process.pid,
      'os.type': process.platform,
      'host.arch': process.arch,
      ...(nodeId ? { 'baton.node.id': nodeId } : {}),
    },
  }
  const exporter = Layer.mergeAll(
    OtlpTracer.layerFromConfig({ resource }),
    OtlpLogger.layerFromConfig({ resource }),
    OtlpMetrics.layerFromConfig({ resource }),
  ).pipe(
    Layer.provide(privateSerialization(nodeId)),
    Layer.provide(exportClient(timeouts, env.BATON_TELEMETRY_LOCAL_RELAY === '1')),
    Layer.provide(ConfigProvider.layer(provider)),
  )
  return Layer.merge(exporter, Layer.succeed(Statement.SpanPropagationEnabled, true))
}
