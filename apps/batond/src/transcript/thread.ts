import { join } from 'node:path'
import type { SessionRequest, SessionResult } from '@baton/protocol'
import { latestThreadTranscriptFile, readTranscriptPage } from './reader.ts'
import { readOutputRetentionDays } from '../worker/full-output.ts'

/** Thread transcript 读取不启动 Worker，也不读取原生历史。 */
export const readThreadTranscriptResult = async (
  dataDirectory: string,
  threadDirectory: string,
  request: SessionRequest,
): Promise<SessionResult> => {
  const base: SessionResult = {
    type: 'session.result',
    operation_id: request.operation_id,
    session_id: request.session_id,
    ok: false,
    gap: false,
  }
  if (request.action !== 'transcript') return { ...base, code: 'invalid_request' }
  const file = request.storage_generation
    ? join(threadDirectory, request.storage_generation, 'transcript.jsonl')
    : await latestThreadTranscriptFile(dataDirectory, request.session_id)
  if (!file) return { ...base, code: 'transcript_missing' }
  const days = await readOutputRetentionDays(dataDirectory).catch(() => 30)
  const result = await readTranscriptPage(file, request.cursor, days)
  if (!result.ok) return { ...base, code: result.code }
  return { ...base, ok: true, transcript: result.page }
}
