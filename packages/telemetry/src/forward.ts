import { Schema } from 'effect'
import { safeAttributes, tokenUsageAttributes } from './attributes.js'
import { boundAttributeString } from './genai.js'
import { metricNames, metricValues as metricLabels } from './metrics.js'
import { sanitizeReplay } from './replay.js'

export type ForwardSignal = 'traces' | 'logs' | 'metrics'
export interface ForwardIdentity {
  employeeId: string
  nodeId?: string
}
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

const services = new Set([
  'baton-server',
  'batond',
  'baton-worker',
  'baton-agent-host',
  'baton-project-runtime',
  'baton-web',
])
const records = (input: unknown): Record<string, unknown>[] => (Array.isArray(input) ? input.filter(isRecord) : [])
const numberValue = (value: unknown) =>
  (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
  (typeof value === 'string' && /^\d{1,20}$/.test(value))
const scalar = (key: string, value: unknown, metric: boolean): unknown => {
  if (!isRecord(value)) return undefined
  if (metric)
    return typeof value.stringValue === 'string' && metricLabels[key]?.has(value.stringValue)
      ? { stringValue: value.stringValue }
      : undefined
  if (typeof value.stringValue === 'string') {
    if (key === 'rum.sessionId' && !/^[0-9a-f]{32}$/i.test(value.stringValue)) return undefined
    return { stringValue: boundAttributeString(key, value.stringValue) }
  }
  if (typeof value.boolValue === 'boolean') return { boolValue: value.boolValue }
  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    const values = value.arrayValue.values.flatMap((entry) =>
      isRecord(entry) && typeof entry.stringValue === 'string'
        ? [{ stringValue: boundAttributeString(key, entry.stringValue) }]
        : [],
    )
    return { arrayValue: { values } }
  }
  if (numberValue(value.intValue)) return { intValue: value.intValue }
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue))
    return { doubleValue: value.doubleValue }
  return undefined
}
const attributes = (input: unknown, identity: ForwardIdentity, metric = false) => {
  const out = records(input).flatMap((attribute) => {
    const key = attribute.key
    if (
      typeof key !== 'string' ||
      !safeAttributes.has(key) ||
      key === 'baton.employee.id' ||
      key === 'user.id' ||
      key === 'baton.node.id'
    )
      return []
    const value = scalar(key, attribute.value, metric)
    return value ? [{ key, value }] : []
  })
  if (!metric) {
    out.push({ key: 'baton.employee.id', value: { stringValue: identity.employeeId } })
    out.push({ key: 'user.id', value: { stringValue: identity.employeeId } })
    if (identity.nodeId) out.push({ key: 'baton.node.id', value: { stringValue: identity.nodeId } })
  }
  return out
}
const hex = (value: unknown, length: number) =>
  typeof value === 'string' && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) ? value : undefined
const nanos = (value: unknown) =>
  typeof value === 'string' && /^\d{1,20}$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : undefined
const replayRecords = (input: unknown, identity: ForwardIdentity) => {
  const groups = new Map<number, Array<{ chunk: number; total: number; offset: number; body: string; time: string }>>()
  for (const record of records(input)) {
    const body = isRecord(record.body) ? record.body.stringValue : undefined
    const counters = new Map<string, number>()
    let duplicate = false
    for (const attr of records(record.attributes)) {
      if (typeof attr.key !== 'string' || !isRecord(attr.value)) continue
      const raw = attr.value.doubleValue ?? attr.value.intValue
      const value = typeof raw === 'string' ? Number(raw) : raw
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        if (counters.has(attr.key)) duplicate = true
        counters.set(attr.key, value)
      }
    }
    const event = counters.get('rr-web.event'),
      chunk = counters.get('rr-web.chunk')
    const total = counters.get('rr-web.total-chunks'),
      offset = counters.get('rr-web.offset')
    const time = nanos(record.timeUnixNano)
    if (
      duplicate ||
      typeof body !== 'string' ||
      event === undefined ||
      !chunk ||
      !total ||
      offset === undefined ||
      !time ||
      chunk > total ||
      total > 1024
    )
      continue
    const parts = groups.get(event) ?? []
    parts.push({ chunk, total, offset, body, time })
    groups.set(event, parts)
  }
  return [...groups.entries()].flatMap(([event, parts]) => {
    parts.sort((a, b) => a.chunk - b.chunk)
    if (
      parts.length !== parts[0]!.total ||
      parts.some(
        (part, i) =>
          part.chunk !== i + 1 ||
          part.total !== parts.length ||
          part.time !== parts[0]!.time ||
          part.offset !== parts[0]!.offset + i,
      )
    )
      return []
    let decoded: unknown
    try {
      decoded = JSON.parse(parts.map((part) => part.body).join(''))
    } catch {
      return []
    }
    const sanitized = sanitizeReplay(decoded)
    if (!isRecord(decoded) || JSON.stringify(decoded) !== JSON.stringify(sanitized)) return []
    return parts.map((part) => ({
      timeUnixNano: part.time,
      body: { stringValue: part.body },
      attributes: [
        { key: 'rr-web.offset', value: { intValue: String(part.offset) } },
        { key: 'rr-web.event', value: { intValue: String(event) } },
        { key: 'rr-web.chunk', value: { intValue: String(part.chunk) } },
        { key: 'rr-web.total-chunks', value: { intValue: String(part.total) } },
        { key: 'baton.employee.id', value: { stringValue: identity.employeeId } },
        { key: 'user.id', value: { stringValue: identity.employeeId } },
      ],
    }))
  })
}

export function filterForward(
  signal: ForwardSignal,
  payload: unknown,
  identity: ForwardIdentity,
): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  const root = signal === 'traces' ? 'resourceSpans' : signal === 'logs' ? 'resourceLogs' : 'resourceMetrics'
  const groups = records(payload[root])
  if (!groups.length) return undefined
  for (const group of groups) {
    const resource = isRecord(group.resource) ? group.resource : undefined
    const resourceAttributes = records(resource?.attributes)
    const serviceAttributes = resourceAttributes.filter((a) => a.key === 'service.name')
    const service = serviceAttributes[0]
    if (
      serviceAttributes.length !== 1 ||
      !service ||
      !isRecord(service.value) ||
      typeof service.value.stringValue !== 'string' ||
      !services.has(service.value.stringValue)
    )
      return undefined
    if ((service.value.stringValue === 'baton-web') !== (identity.nodeId === undefined)) return undefined
    if (signal === 'logs' && identity.nodeId === undefined) {
      const sessions = resourceAttributes.filter((a) => a.key === 'rum.sessionId')
      const session = sessions[0]
      if (
        sessions.length !== 1 ||
        !session ||
        !isRecord(session.value) ||
        typeof session.value.stringValue !== 'string' ||
        !/^[0-9a-f]{32}$/i.test(session.value.stringValue)
      )
        return undefined
    }
  }
  return {
    [root]: groups.map((group) => {
      const resource = isRecord(group.resource) ? group.resource : {}
      const scopeKey = signal === 'traces' ? 'scopeSpans' : signal === 'logs' ? 'scopeLogs' : 'scopeMetrics'
      const scopes = records(group[scopeKey]).map((scope) => {
        if (signal === 'traces')
          return {
            scope: { name: 'baton' },
            spans: records(scope.spans).flatMap((span) => {
              const traceId = hex(span.traceId, 32),
                spanId = hex(span.spanId, 16)
              const startTimeUnixNano = nanos(span.startTimeUnixNano),
                endTimeUnixNano = nanos(span.endTimeUnixNano)
              if (!traceId || !spanId || !startTimeUnixNano || !endTimeUnixNano) return []
              const attrs = attributes(span.attributes, identity)
              if (
                attrs.some(
                  (item) =>
                    item.key === 'baton.usage.reported' && isRecord(item.value) && item.value.boolValue === false,
                )
              ) {
                for (let index = attrs.length - 1; index >= 0; index--) {
                  if (tokenUsageAttributes.includes(attrs[index]!.key)) attrs.splice(index, 1)
                }
              }
              const status =
                isRecord(span.status) && [0, 1, 2].includes(Number(span.status.code)) ? Number(span.status.code) : 0
              return [
                {
                  traceId,
                  spanId,
                  ...(hex(span.parentSpanId, 16) ? { parentSpanId: hex(span.parentSpanId, 16) } : {}),
                  name: typeof span.name === 'string' ? span.name : 'baton.span',
                  kind: typeof span.kind === 'number' && span.kind >= 0 && span.kind <= 5 ? span.kind : 0,
                  startTimeUnixNano,
                  endTimeUnixNano,
                  attributes: attrs,
                  events: records(span.events).flatMap((event) => {
                    const timeUnixNano = nanos(event.timeUnixNano)
                    return timeUnixNano &&
                      [
                        'effect.sql.transaction.commit',
                        'effect.sql.transaction.rollback',
                        'effect.sql.transaction.savepoint',
                      ].includes(String(event.name))
                      ? [{ name: event.name, timeUnixNano, attributes: [] }]
                      : []
                  }),
                  links: records(span.links).flatMap((link) => {
                    const linkedTraceId = hex(link.traceId, 32)
                    const linkedSpanId = hex(link.spanId, 16)
                    return linkedTraceId && linkedSpanId
                      ? [{ traceId: linkedTraceId, spanId: linkedSpanId, attributes: [] }]
                      : []
                  }),
                  status: { code: status },
                },
              ]
            }),
          }
        if (signal === 'logs' && !identity.nodeId)
          return { scope: { name: 'rum.rr-web' }, logRecords: replayRecords(scope.logRecords, identity) }
        if (signal === 'logs')
          return {
            scope: { name: 'baton' },
            logRecords: records(scope.logRecords).flatMap((record) => {
              const body = isRecord(record.body) ? record.body.stringValue : undefined
              if (body !== 'baton.wait.start' && body !== 'baton.wait.end') return []
              const timeUnixNano = nanos(record.timeUnixNano)
              if (!timeUnixNano) return []
              return [
                {
                  timeUnixNano,
                  body: { stringValue: body },
                  attributes: attributes(record.attributes, identity),
                  ...(hex(record.traceId, 32) ? { traceId: hex(record.traceId, 32) } : {}),
                  ...(hex(record.spanId, 16) ? { spanId: hex(record.spanId, 16) } : {}),
                },
              ]
            }),
          }
        return {
          scope: { name: 'baton' },
          metrics: records(scope.metrics).flatMap((metric) => {
            if (typeof metric.name !== 'string' || !metricNames.has(metric.name)) return []
            const gauge = isRecord(metric.gauge) ? metric.gauge : undefined
            if (!gauge) return []
            return [
              {
                name: metric.name,
                gauge: {
                  dataPoints: records(gauge.dataPoints).flatMap((point) => {
                    const timeUnixNano = nanos(point.timeUnixNano)
                    if (!timeUnixNano) return []
                    const value = numberValue(point.asInt)
                      ? { asInt: point.asInt }
                      : numberValue(point.asDouble)
                        ? { asDouble: point.asDouble }
                        : undefined
                    return value
                      ? [{ timeUnixNano, attributes: attributes(point.attributes, identity, true), ...value }]
                      : []
                  }),
                },
              },
            ]
          }),
        }
      })
      return { resource: { attributes: attributes(resource.attributes, identity) }, [scopeKey]: scopes }
    }),
  }
}
