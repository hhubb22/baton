import { ROOT_CONTEXT, SpanStatusCode, trace, type TracerProvider } from '@opentelemetry/api'
import Rum, { INSTRUMENTATIONS_ALL_DISABLED } from '@hyperdx/otel-web'
import Recorder from '@hyperdx/otel-web-session-recorder'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { privateExporter, safeErrorType } from './exporter'
import { sanitizeReplay } from './replay'
import { sourceLocation } from './source'
import { setExceptionReporter } from './runtime'

declare const __BATON_BUILD__: { version: string; commit: string }

export interface TelemetryConfig {
  session_replay?: 'masked'
}
let active: string | undefined
let generation = 0
let removeErrors: (() => void) | undefined

export function stopTelemetry() {
  if (!active) return
  generation++
  removeErrors?.()
  setExceptionReporter()
  removeErrors = undefined
  Recorder.deinit()
  Rum.deinit()
  active = undefined
}

export function startTelemetry(config: TelemetryConfig, getCsrf: () => string | null) {
  const identity = JSON.stringify(config)
  if (identity === active) return
  stopTelemetry()
  const currentGeneration = ++generation
  const base = new URL('/api/v1/telemetry', window.location.origin).toString()
  const api = new RegExp(`^${window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/`)
  const ignored = new RegExp(`^(?!${window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/|/api/)`)
  active = identity
  Rum._internalInit({
    url: `${base}/v1/traces`,
    applicationName: 'baton-web',
    allowInsecureUrl: true,
    ignoreUrls: [
      ignored,
      /^\/api\/v1\/telemetry(?:\/|$)/,
      new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`),
    ],
    instrumentations: {
      ...INSTRUMENTATIONS_ALL_DISABLED,
      fetch: { propagateTraceHeaderCorsUrls: [api], advancedNetworkCapture: () => false },
    },
    exporter: {
      factory: ({ url: exportUrl }) =>
        privateExporter(
          new OTLPTraceExporter({
            url: exportUrl,
            headers: async () => ({ 'x-csrf-token': getCsrf() ?? '' }),
          }),
          config.session_replay === 'masked',
          () =>
            queueMicrotask(() => {
              if (generation === currentGeneration) stopTelemetry()
            }),
        ),
    },
  })
  const provider = Rum.provider
  if (!provider) return
  const originalResource = provider.resource
  const attributes = {
    'service.name': 'baton-web',
    'service.version': __BATON_BUILD__.version,
    'vcs.ref.head.revision': __BATON_BUILD__.commit,
    get 'rum.sessionId'() {
      const value = originalResource.attributes['rum.sessionId']
      return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value) ? value : undefined
    },
  }
  const delegate = {
    getTracer: provider.getTracer.bind(provider),
    resource: { attributes },
  }
  trace.disable()
  trace.setGlobalTracerProvider(delegate as TracerProvider)
  const onError = (event: ErrorEvent) => {
    const location = sourceLocation(event.filename, event.lineno, event.colno)
    const span = trace.getTracer('baton-web').startSpan('baton.web.exception', {
      attributes: { 'error.type': safeErrorType(event.error?.name), ...location },
    })
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    const span = trace.getTracer('baton-web').startSpan('baton.web.exception', {
      attributes: {
        'error.type': event.reason instanceof Error ? safeErrorType(event.reason.name) : 'PromiseRejection',
      },
    })
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  }
  setExceptionReporter((error) => {
    const span = trace.getTracer('baton-web').startSpan('baton.web.exception', {
      attributes: { 'error.type': error instanceof Error ? safeErrorType(error.name) : 'Error' },
    })
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  removeErrors = () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
  if (config.session_replay === 'masked' && attributes['rum.sessionId']) {
    let lookup: ((id: number) => Node | null) | undefined
    Recorder.init({
      url: `${base}/v1/logs`,
      maskAllInputs: true,
      maskTextSelector: '*',
      plugins: [
        {
          name: 'baton-private',
          options: {},
          getMirror: ({ nodeMirror }) => {
            lookup = (id) => nodeMirror.getNode(id)
          },
          eventProcessor: (event) => sanitizeReplay(event, lookup) as typeof event,
        },
      ],
    })
  }
}

export function traceSocket(socket: WebSocket) {
  if (!active) return
  const span = trace.getTracer('baton-web').startSpan('baton.web.socket', {}, ROOT_CONTEXT)
  const finish = (failed: boolean) => {
    socket.removeEventListener('open', opened)
    socket.removeEventListener('error', failedOpen)
    socket.removeEventListener('close', failedOpen)
    if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  }
  const opened = () => finish(false)
  const failedOpen = () => finish(true)
  socket.addEventListener('open', opened, { once: true })
  socket.addEventListener('error', failedOpen, { once: true })
  socket.addEventListener('close', failedOpen, { once: true })
}
