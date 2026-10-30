import { Schema } from 'effect'
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderApprovalFullAccessOverride,
} from '@t3tools/contracts'
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
  kind: Schema.Literals(['user_input', 'mcp-elicitation', 'approval']),
  questions: Schema.Array(ThreadQuestionItem).check(uniqueBy((question) => question.id)),
  prompt: Schema.optionalKey(boundedText(64 * 1024)),
  reason: Schema.optionalKey(boundedText(64 * 1024)),
  request_kind: Schema.optionalKey(ProviderRequestKind),
  options: Schema.optionalKey(Schema.Array(ProviderApprovalOption)),
  full_access_override: Schema.optionalKey(ProviderApprovalFullAccessOverride),
}).check(jsonLimit(64 * 1024))
export type ThreadQuestion = typeof ThreadQuestion.Type

export const ThreadAnswerInput = Schema.Struct({
  request_id: nonemptyText(512),
  decision: ProviderApprovalDecision,
  answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
}).check(jsonLimit(64 * 1024))
export type ThreadAnswerInput = typeof ThreadAnswerInput.Type

export function isThreadAnswerAllowed(question: ThreadQuestion, answer: ThreadAnswerInput): boolean {
  if (question.kind !== 'approval') return answer.decision === 'accept' || answer.decision === 'cancel'
  return question.options === undefined
    ? ['accept', 'decline', 'cancel'].includes(answer.decision)
    : question.options.some((option) => option.decision === answer.decision)
}

export const ThreadQuestionAnswer = Schema.Struct({
  request_id: nonemptyText(512),
  decision: ProviderApprovalDecision,
  outcome: Schema.Union([Schema.Literal('pending'), CommandOutcome]),
  reason: Schema.optionalKey(boundedText(4096)),
})
export type ThreadQuestionAnswer = typeof ThreadQuestionAnswer.Type
