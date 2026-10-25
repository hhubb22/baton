import { Schema } from 'effect'
import { CommandOutcome, boundedText, jsonLimit, nonemptyText, uniqueBy } from './common.ts'

export const ThreadQuestionItem = Schema.Struct({
  id: nonemptyText(512),
  header: boundedText(4096),
  question: boundedText(64 * 1024),
  options: Schema.Array(
    Schema.Struct({
      label: boundedText(4096),
      description: boundedText(16 * 1024),
      value: Schema.optionalKey(Schema.Json),
    }),
  ),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  allowCustomAnswer: Schema.optionalKey(Schema.Boolean),
  initialAnswer: Schema.optionalKey(Schema.Json),
  required: Schema.optionalKey(Schema.Boolean),
})
export type ThreadQuestionItem = typeof ThreadQuestionItem.Type

export const ThreadQuestion = Schema.Struct({
  request_id: nonemptyText(512),
  kind: Schema.Literals(['user_input', 'mcp-elicitation']),
  questions: Schema.Array(ThreadQuestionItem).check(uniqueBy((question) => question.id)),
  prompt: Schema.optionalKey(boundedText(64 * 1024)),
}).check(jsonLimit(64 * 1024))
export type ThreadQuestion = typeof ThreadQuestion.Type

export const ThreadAnswerInput = Schema.Struct({
  request_id: nonemptyText(512),
  decision: Schema.Literals(['accept', 'cancel']),
  answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
}).check(jsonLimit(64 * 1024))
export type ThreadAnswerInput = typeof ThreadAnswerInput.Type

export const ThreadQuestionAnswer = Schema.Struct({
  request_id: nonemptyText(512),
  decision: Schema.Literals(['accept', 'cancel']),
  outcome: Schema.Union([Schema.Literal('pending'), CommandOutcome]),
  reason: Schema.optionalKey(boundedText(4096)),
})
export type ThreadQuestionAnswer = typeof ThreadQuestionAnswer.Type
