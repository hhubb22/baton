import { DateTime, Effect, Schema } from 'effect'
import type { ProjectPreview } from '@baton/protocol'
import { projectDecode, projectError } from './store.ts'

const previews = new Map<string, { value: ProjectPreview; expires: number; updated: number }>()
const PreviewInput = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })
export const saveProjectPreview = Effect.fn('saveProjectPreview')(function* (
  runId: string,
  afterSeq: number,
  payload: unknown,
) {
  const p = yield* projectDecode(PreviewInput, payload)
  if (Buffer.byteLength(p.text) > 32 * 1024 || p.text.includes('\0'))
    return yield* Effect.fail(projectError('invalid', 422))
  const now = yield* DateTime.now,
    ms = DateTime.toEpochMillis(now)
  for (const [id, entry] of previews) if (entry.expires <= ms) previews.delete(id)
  if ((previews.get(runId)?.updated ?? 0) + 1000 > ms) return
  if (previews.size >= 256 && !previews.has(runId)) previews.delete(previews.keys().next().value!)
  previews.set(runId, {
    value: { after_seq: afterSeq, text: p.text, truncated: p.truncated, updated_at: DateTime.formatIso(now) },
    expires: ms + 30_000,
    updated: ms,
  })
})
export const readProjectPreview = Effect.fn('readProjectPreview')(function* (runId: string, afterSeq: number) {
  const entry = previews.get(runId),
    now = DateTime.toEpochMillis(yield* DateTime.now)
  if (!entry || entry.expires <= now || entry.value.after_seq !== afterSeq) return undefined
  return entry.value
})
