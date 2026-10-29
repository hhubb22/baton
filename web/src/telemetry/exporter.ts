import { safeAttributes } from '@baton/telemetry/attributes'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

const browserFields = new Set([
  'http.request.method',
  'http.response.status_code',
  'error.type',
  'baton.web.source.asset',
  'code.line.number',
  'code.column.number',
])
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const errors = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'PromiseRejection',
])

export function safeErrorType(value: unknown) {
  return typeof value === 'string' && errors.has(value) ? value : 'Error'
}

export function filteredSpan(span: ReadableSpan, replay = false): ReadableSpan {
  const normalized = {
    ...span.attributes,
    ...(!span.attributes['http.request.method'] && span.attributes['http.method']
      ? { 'http.request.method': span.attributes['http.method'] }
      : {}),
    ...(!span.attributes['http.response.status_code'] && span.attributes['http.status_code']
      ? { 'http.response.status_code': span.attributes['http.status_code'] }
      : {}),
  }
  const attributes = Object.fromEntries(
    Object.entries(normalized).filter(([key, value]) => {
      if (!safeAttributes.has(key) || !browserFields.has(key)) return false
      if (key === 'http.request.method') return typeof value === 'string' && methods.has(value)
      if (key === 'http.response.status_code')
        return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
      if (key === 'error.type') return typeof value === 'string' && errors.has(value)
      if (key === 'baton.web.source.asset')
        return typeof value === 'string' && /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.js$/.test(value)
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000
    }),
  )
  const resource = Object.create(span.resource) as ReadableSpan['resource']
  const session = span.resource.attributes['rum.sessionId']
  Object.defineProperty(resource, 'attributes', {
    value: {
      'service.name': 'baton-web',
      'service.version': __BATON_BUILD__.version,
      'vcs.ref.head.revision': __BATON_BUILD__.commit,
      ...(replay &&
      safeAttributes.has('rum.sessionId') &&
      typeof session === 'string' &&
      /^[0-9a-f]{32}$/i.test(session)
        ? { 'rum.sessionId': session }
        : {}),
    },
  })
  const filtered = Object.create(span) as ReadableSpan
  Object.defineProperties(filtered, {
    name: { value: ['baton.web.exception', 'baton.web.socket'].includes(span.name) ? span.name : 'baton.web.request' },
    attributes: { value: attributes },
    resource: { value: resource },
    events: { value: [] },
    links: { value: [] },
    status: { value: { code: span.status.code } },
    instrumentationScope: { value: { name: 'baton-web' } },
  })
  return filtered
}

declare const __BATON_BUILD__: { version: string; commit: string }

export function privateExporter(exporter: SpanExporter, replay = false, onDisabled?: () => void): SpanExporter {
  return {
    export: (spans, result) =>
      exporter.export(
        spans.map((span) => filteredSpan(span, replay)),
        (outcome) => {
          if (outcome.error?.message === 'Fetch request failed with non-retryable status 404') onDisabled?.()
          result(outcome)
        },
      ),
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  }
}
