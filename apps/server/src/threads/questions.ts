import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { audit, decode, enqueue, failure, readThread, touch, type DB } from './core.ts'
import { canonical } from '../json.ts'
import { transaction } from '../database.ts'

export type PendingQuestion = P.ThreadQuestion & { readonly worker_turn_seq: number }

export const pendingQuestions = Effect.fn('threads.pendingQuestions')(function* (t: P.Thread) {
  const sql = yield* SqlClient.SqlClient
  if (t.status !== 'running' || t.stop_requested_at || t.archive_requested_at) return []
  const rows = yield* sql<{ question: PendingQuestion }>`SELECT
    e.payload->'question' || jsonb_build_object('worker_turn_seq',v.worker_turn_seq) AS question
    FROM thread_events e JOIN thread_turns v ON v.thread_id=e.thread_id
      AND v.worker_turn_seq=(e.payload->>'worker_turn_seq')::bigint AND v.ended_at IS NULL
    WHERE e.employee_id=${t.employee_id} AND e.thread_id=${t.id} AND e.kind='question.pending'
      AND NOT EXISTS(SELECT 1 FROM thread_events done WHERE done.thread_id=e.thread_id
        AND done.kind IN ('question.resolved','question.answered')
        AND done.payload->>'request_id'=e.payload->'question'->>'request_id')
    ORDER BY e.id`
  return rows.map((row) => row.question)
})

export const questionAnswers = Effect.fn('threads.questionAnswers')(function* (t: P.Thread) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ value: P.ThreadQuestionAnswer }>`SELECT jsonb_strip_nulls(jsonb_build_object(
    'request_id',payload->'answer'->>'request_id','decision',payload->'answer'->>'decision',
    'outcome',COALESCE(completion->>'command_outcome','pending'),'reason',completion->>'reason')) AS value
    FROM thread_outbox WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND action='answer'
    ORDER BY id DESC LIMIT 10`
  return rows.map((row) => row.value)
})

export const answer = (employeeID: string, threadID: string, input: P.ThreadAnswerInput): DB<void> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const valid = yield* decode(P.ThreadAnswerInput, input)
      const t = yield* readThread(employeeID, threadID, true)
      const [saved] = yield* sql<{ payload: P.ThreadAnswerInput }>`SELECT payload FROM thread_events
        WHERE employee_id=${employeeID} AND thread_id=${threadID} AND kind='question.answered'
        AND payload->>'request_id'=${valid.request_id} ORDER BY id LIMIT 1`
      if (saved) {
        if (canonical(saved.payload) !== canonical(valid)) return yield* Effect.fail(failure('answer_conflict'))
        return
      }
      if (t.status !== 'running' || t.stop_requested_at || t.archive_requested_at)
        return yield* Effect.fail(failure('question_closed'))
      const question = (yield* pendingQuestions(t)).find((item) => item.request_id === valid.request_id)
      if (!question) return yield* Effect.fail(failure('question_closed'))
      if (valid.decision === 'accept' && question.kind === 'user_input' && valid.answers === undefined)
        return yield* Effect.fail(failure('answers_required', 422))
      if (valid.decision === 'accept') {
        for (const item of question.questions) {
          const value = valid.answers && Object.hasOwn(valid.answers, item.id) ? valid.answers[item.id] : undefined
          if (
            item.required !== false &&
            (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
          )
            return yield* Effect.fail(failure('answers_required', 422))
        }
      }
      yield* enqueue(t, 'answer', { answer: valid, worker_turn_seq: question.worker_turn_seq })
      yield* audit(t, 'question.answered', valid)
      yield* touch(t.id)
    }),
  )
