import { expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { ThreadAnswerInput, ThreadQuestion, ThreadReport, WorkerAnswer } from '../src/index.ts'

it('accepts user questions, JSON answers, and MCP confirmation within a shared 64 KB budget', () => {
  expect(
    Schema.is(ThreadQuestion)({ request_id: 'confirm', kind: 'mcp-elicitation', questions: [], prompt: 'Continue?' }),
  ).toBe(true)
  const question = {
    request_id: 'question',
    kind: 'user_input',
    questions: [
      {
        id: 'target',
        header: 'Target',
        question: 'Which targets?',
        options: [{ label: 'Linux', description: '', value: 'linux' }],
        multiSelect: true,
      },
    ],
  }
  expect(Schema.is(ThreadQuestion)(question)).toBe(true)
  expect(
    Schema.is(ThreadAnswerInput)({
      request_id: 'question',
      decision: 'accept',
      answers: { target: ['linux'], custom: { enabled: true } },
    }),
  ).toBe(true)
  expect(Schema.is(ThreadQuestion)({ ...question, prompt: 'a'.repeat(64 * 1024) })).toBe(false)
  expect(
    Schema.is(ThreadAnswerInput)({
      request_id: 'question',
      decision: 'accept',
      answers: { target: 'a'.repeat(64 * 1024) },
    }),
  ).toBe(false)
  expect(Schema.is(ThreadQuestion)({ ...question, questions: [...question.questions, ...question.questions] })).toBe(
    false,
  )
})

it('requires question report identity and answer command payloads', () => {
  const report = {
    type: 'thread.report',
    thread_id: '11111111-1111-4111-8111-111111111111',
    event_id: '22222222-2222-4222-8222-222222222222',
    worker_seq: 1,
    kind: 'question.pending',
  }
  expect(Schema.is(ThreadReport)(report)).toBe(false)
  expect(Schema.is(ThreadReport)({ ...report, kind: 'question.resolved' })).toBe(false)
  const command = {
    type: 'thread_answer',
    ok: true,
    thread_id: report.thread_id,
    command_id: report.event_id,
    storage_generation: 'generation',
  }
  expect(Schema.is(WorkerAnswer)(command)).toBe(false)
  expect(Schema.is(WorkerAnswer)({ ...command, answer: { request_id: 'confirm', decision: 'cancel' } })).toBe(true)
})
