import type { TraceData } from 'effect/observability/OtlpTracer'

export const localTraceBatchBytes = 1536 * 1024

type Resource = TraceData['resourceSpans'][number]
type Scope = Resource['scopeSpans'][number]
type Span = Scope['spans'][number]

const payload = (resource: Resource, scope: Scope, spans: Span[]): TraceData => ({
  resourceSpans: [{ ...resource, scopeSpans: [{ ...scope, spans }] }],
})
const encode = (data: TraceData) => Buffer.from(JSON.stringify(data))

/** Split only oversized local trace exports; ordinary batches keep their original serialization. */
export const splitLocalTraceBatch = (
  body: Uint8Array,
  maxBytes: number,
  targetBytes = localTraceBatchBytes,
): Uint8Array[] => {
  if (body.byteLength <= targetBytes) return [body]
  const data = JSON.parse(Buffer.from(body).toString('utf8')) as TraceData
  const chunks: Uint8Array[] = []
  for (const resource of data.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      let spans: Span[] = []
      const flush = () => {
        if (spans.length) chunks.push(encode(payload(resource, scope, spans)))
        spans = []
      }
      for (const span of scope.spans) {
        if (spans.length && encode(payload(resource, scope, [...spans, span])).byteLength > targetBytes) flush()
        if (encode(payload(resource, scope, [span])).byteLength > maxBytes) continue
        spans.push(span)
        if (encode(payload(resource, scope, spans)).byteLength > targetBytes) flush()
      }
      flush()
    }
  }
  return chunks
}
