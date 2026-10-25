import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import type * as P from '@baton/protocol'
import { seedNode, withTestDatabase, type TestDatabase } from './testing/database.ts'
import * as threads from './threads.ts'

type Run = TestDatabase['run']
const query = (statement: string, ...parameters: ReadonlyArray<string | number | boolean>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe(statement, parameters)
  })

async function fixture(run: Run) {
  const node = await seedNode(run, {
    report: {
      repos: [],
      exec: { enabled: false, shell: '/bin/sh' },
      roots: [{ root_id: 'work', path: '/workspace' }],
      agents: [
        {
          agent_type: 'codex',
          status: 'available',
          version: 'test',
          default_model: 'default',
          models: [],
          capabilities: { create: true, queue: true, steer: true, resume: true, stop: true, switch_model: true },
        },
      ],
    },
  })
  const clientMessageId = randomUUID()
  const { thread } = await run(
    threads.create(node.employeeId, {
      client_thread_id: randomUUID(),
      node_id: node.nodeId,
      agent_type: 'codex',
      working_directory: '/workspace',
      message: { client_message_id: clientMessageId, content: 'Original input' },
    }),
  )
  const [open] = await run(threads.claimCommands())
  if (!open) throw new Error('Expected open command')
  await run(
    threads.processReceipt(node.source, open.message_id, {
      type: 'thread.command_result',
      thread_id: thread.id,
      storage_generation: 'generation',
      ok: true,
    }),
  )
  let seq = 0
  const report = (kind: P.ThreadReport['kind'], extra: Partial<P.ThreadReport> = {}): P.ThreadReport => ({
    type: 'thread.report',
    thread_id: thread.id,
    event_id: randomUUID(),
    worker_seq: ++seq,
    kind,
    storage_generation: 'generation',
    ...extra,
  })
  await run(threads.processReport(node.source, report('thread.opened')))
  const [message] = await run(threads.claimCommands())
  if (!message) throw new Error('Expected initial message command')
  await run(
    threads.processReceipt(node.source, message.message_id, {
      type: 'thread.command_result',
      thread_id: thread.id,
      ok: true,
      storage_generation: 'generation',
    }),
  )
  await run(
    threads.processReport(
      node.source,
      report('turn.started', { worker_turn_seq: 1, client_message_id: clientMessageId }),
    ),
  )
  await run(
    threads.processReport(
      node.source,
      report('message.sent', { worker_turn_seq: 1, client_message_id: clientMessageId }),
    ),
  )
  const question: P.ThreadQuestion = {
    request_id: randomUUID(),
    kind: 'user_input',
    questions: [
      {
        id: 'target',
        header: 'Target',
        question: 'Which targets?',
        multiSelect: true,
        allowCustomAnswer: true,
        options: [
          { label: 'Linux', description: 'Linux build', value: 'linux' },
          { label: 'macOS', description: 'macOS build', value: 'macos' },
        ],
      },
    ],
  }
  return { ...node, thread, question, report }
}

it('persists questions and offline answers across restart, enforces ownership and deduplicates delivery', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const pending = f.report('question.pending', { question: f.question, worker_turn_seq: 1 })
    expect(await run(threads.processReport(f.source, pending))).toMatchObject({ ok: true })
    expect(await run(threads.processReport(f.source, pending))).toMatchObject({ ok: true })
    const recovered = await restart()
    expect((await recovered(threads.view(f.employeeId, f.thread.id))).pending_questions).toEqual([
      { ...f.question, worker_turn_seq: 1 },
    ])
    const answer: P.ThreadAnswerInput = {
      request_id: f.question.request_id,
      decision: 'accept',
      answers: { target: ['linux', 'macos'] },
    }
    const stranger = await seedNode(recovered)
    await expect(recovered(threads.answer(stranger.employeeId, f.thread.id, answer))).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      recovered(threads.processReport(stranger.source, { ...pending, event_id: randomUUID() })),
    ).rejects.toMatchObject({ status: 404 })
    await recovered(query('UPDATE node_presence SET online=false WHERE node_id=$1', f.nodeId))
    await recovered(threads.answer(f.employeeId, f.thread.id, answer))
    await recovered(threads.answer(f.employeeId, f.thread.id, answer))
    await expect(
      recovered(threads.answer(f.employeeId, f.thread.id, { ...answer, decision: 'cancel' })),
    ).rejects.toMatchObject({ code: 'answer_conflict' })
    expect(await recovered(threads.claimCommands())).toEqual([])
    const afterAnswer = await restart()
    expect((await afterAnswer(threads.view(f.employeeId, f.thread.id))).question_answers).toEqual([
      { request_id: answer.request_id, decision: 'accept', outcome: 'pending' },
    ])
    await afterAnswer(query('UPDATE node_presence SET online=true WHERE node_id=$1', f.nodeId))
    const commands = await afterAnswer(threads.claimCommands())
    expect(commands).toHaveLength(1)
    const command = commands[0]
    if (!command) throw new Error('Expected answer command')
    expect(command.body).toMatchObject({ action: 'answer', answer })
    await afterAnswer(
      threads.processReceipt(f.source, command.message_id, {
        type: 'thread.command_result',
        thread_id: f.thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    await afterAnswer(
      threads.processReport(
        f.source,
        f.report('command.completed', {
          command_id: command.message_id,
          command_outcome: 'unknown',
          reason: 'answer_delivery_uncertain',
        }),
      ),
    )
    const view = await afterAnswer(threads.view(f.employeeId, f.thread.id))
    expect(view.pending_questions).toEqual([])
    expect(view.question_answers).toEqual([
      { request_id: answer.request_id, decision: 'accept', outcome: 'unknown', reason: 'answer_delivery_uncertain' },
    ])
    expect(await afterAnswer(threads.claimCommands())).toEqual([])
    const messages = await afterAnswer(
      query('SELECT content,status FROM thread_messages WHERE thread_id=$1', f.thread.id),
    )
    expect(messages).toEqual([{ content: 'Original input', status: 'sent' }])
  }))

it('accepts MCP confirmation and cancellation, closes resolved questions, and rejects stopped or previous-turn answers', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const mcp: P.ThreadQuestion = {
      request_id: 'mcp-confirm',
      kind: 'mcp-elicitation',
      questions: [],
      prompt: 'Connect to the MCP server?',
    }
    await run(threads.processReport(f.source, f.report('question.pending', { question: mcp, worker_turn_seq: 1 })))
    await run(threads.answer(f.employeeId, f.thread.id, { request_id: mcp.request_id, decision: 'accept' }))
    await run(threads.processReport(f.source, f.report('question.resolved', { request_id: mcp.request_id })))
    await run(
      threads.processReport(f.source, f.report('question.pending', { question: f.question, worker_turn_seq: 1 })),
    )
    await run(threads.answer(f.employeeId, f.thread.id, { request_id: f.question.request_id, decision: 'cancel' }))
    const unanswered = { ...f.question, request_id: 'unanswered-previous-turn' }
    await run(
      threads.processReport(f.source, f.report('question.pending', { question: unanswered, worker_turn_seq: 1 })),
    )
    await run(
      threads.processReport(
        f.source,
        f.report('turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true }),
      ),
    )
    await run(threads.answer(f.employeeId, f.thread.id, { request_id: f.question.request_id, decision: 'cancel' }))
    await expect(
      run(
        threads.answer(f.employeeId, f.thread.id, {
          request_id: f.question.request_id,
          decision: 'accept',
          answers: { target: ['linux'] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'answer_conflict' })
    await expect(
      run(threads.answer(f.employeeId, f.thread.id, { request_id: unanswered.request_id, decision: 'cancel' })),
    ).rejects.toMatchObject({ code: 'question_closed' })
    const newMessageId = randomUUID()
    await run(threads.addMessage(f.employeeId, f.thread.id, { client_message_id: newMessageId, content: 'Next input' }))
    const [message] = await run(threads.claimCommands())
    if (!message) throw new Error('Expected next message command')
    await run(
      threads.processReceipt(f.source, message.message_id, {
        type: 'thread.command_result',
        thread_id: f.thread.id,
        storage_generation: 'generation',
        ok: true,
      }),
    )
    await run(
      threads.processReport(
        f.source,
        f.report('turn.started', { worker_turn_seq: 2, client_message_id: newMessageId }),
      ),
    )
    await run(threads.answer(f.employeeId, f.thread.id, { request_id: f.question.request_id, decision: 'cancel' }))
    await expect(
      run(threads.answer(f.employeeId, f.thread.id, { request_id: unanswered.request_id, decision: 'cancel' })),
    ).rejects.toMatchObject({ code: 'question_closed' })
    const next = { ...f.question, request_id: 'next-question' }
    await run(threads.processReport(f.source, f.report('question.pending', { question: next, worker_turn_seq: 2 })))
    await run(threads.answer(f.employeeId, f.thread.id, { request_id: next.request_id, decision: 'cancel' }))
    const stoppedQuestion = { ...f.question, request_id: 'stopped-question' }
    await run(
      threads.processReport(f.source, f.report('question.pending', { question: stoppedQuestion, worker_turn_seq: 2 })),
    )
    await run(threads.stop(f.employeeId, f.thread.id))
    await run(threads.answer(f.employeeId, f.thread.id, { request_id: next.request_id, decision: 'cancel' }))
    await expect(
      run(threads.answer(f.employeeId, f.thread.id, { request_id: stoppedQuestion.request_id, decision: 'cancel' })),
    ).rejects.toMatchObject({ code: 'question_closed' })
    const commands = await run(threads.claimCommands())
    expect(commands.some((command) => command.body.action === 'answer')).toBe(false)
    expect(commands.some((command) => command.body.action === 'stop')).toBe(true)
    expect((await run(threads.view(f.employeeId, f.thread.id))).pending_questions).toEqual([])
    expect((await run(threads.view(f.employeeId, f.thread.id))).question_answers[0]?.outcome).toBe('cancelled')
  }))

it.each(['completion', 'rejection'])(
  'settles an attempted answer after its question closes using the original command ID (%s)',
  (outcome) =>
    withTestDatabase(async ({ run }) => {
      const f = await fixture(run)
      await run(
        threads.processReport(f.source, f.report('question.pending', { question: f.question, worker_turn_seq: 1 })),
      )
      await run(threads.answer(f.employeeId, f.thread.id, { request_id: f.question.request_id, decision: 'cancel' }))
      const [original] = await run(threads.claimCommands())
      if (!original) throw new Error('Expected original answer command')
      await run(
        threads.processReport(
          f.source,
          f.report('turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true }),
        ),
      )
      await run(threads.archive(f.employeeId, f.thread.id))
      await run(
        query('UPDATE thread_outbox SET next_attempt_at=clock_timestamp() WHERE message_id=$1', original.message_id),
      )
      const [retried] = await run(threads.claimCommands())
      expect(retried?.message_id).toBe(original.message_id)
      expect(retried?.body.answer).toEqual(original.body.answer)
      if (outcome === 'completion') {
        await run(
          threads.processReport(
            f.source,
            f.report('command.completed', {
              command_id: original.message_id,
              command_outcome: 'unknown',
              reason: 'answer_delivery_uncertain',
            }),
          ),
        )
        await run(
          threads.processReceipt(f.source, original.message_id, {
            type: 'thread.command_result',
            thread_id: f.thread.id,
            storage_generation: 'generation',
            ok: true,
          }),
        )
      } else {
        await run(
          threads.processReceipt(f.source, original.message_id, {
            type: 'thread.command_result',
            thread_id: f.thread.id,
            storage_generation: 'generation',
            ok: false,
            code: 'question_closed',
          }),
        )
      }
      const view = await run(threads.view(f.employeeId, f.thread.id))
      expect(view.question_answers[0]?.outcome).toBe(outcome === 'completion' ? 'unknown' : 'failed')
      expect(await run(threads.claimCommands())).toEqual([])
      expect(await run(query('SELECT content,status FROM thread_messages WHERE thread_id=$1', f.thread.id))).toEqual([
        { content: 'Original input', status: 'sent' },
      ])
    }),
)

it('requires an own answer property when question IDs match Object prototype keys', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const question: P.ThreadQuestion = {
      ...f.question,
      questions: [{ id: 'toString', header: 'Name', question: 'Which name?', options: [] }],
    }
    await run(threads.processReport(f.source, f.report('question.pending', { question, worker_turn_seq: 1 })))
    await expect(
      run(
        threads.answer(f.employeeId, f.thread.id, { request_id: question.request_id, decision: 'accept', answers: {} }),
      ),
    ).rejects.toMatchObject({ code: 'answers_required' })
    await run(
      threads.answer(f.employeeId, f.thread.id, {
        request_id: question.request_id,
        decision: 'accept',
        answers: { toString: 'saved name' },
      }),
    )
    expect((await run(threads.view(f.employeeId, f.thread.id))).pending_questions).toEqual([])
  }))
