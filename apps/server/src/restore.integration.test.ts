import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import * as Threads from './threads/index.ts'
import * as Projects from './project/projects.ts'
import { getProjectMemory, writeProjectMemory } from './project/memory/index.ts'
import { finalizeRestore } from './restore.ts'
import { withTestDatabase } from './testing/database.ts'

it('RL-A08 preserves restored history and memory, requires new authorization and never redispatches uncertain work', () =>
  withTestDatabase(async ({ run }) => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-restore-'))
    try {
      const keyPath = join(directory, 'node-signing.key')
      const signer = await Nodes.loadSigningKey(keyPath)
      const password = 'offline-restore-password-123'
      const employee = await run(Auth.createEmployee('restore', 'Restore', password))
      await run(Auth.changePassword(employee.id, password, `${password}-ready`))
      const session = await run(Auth.login(employee.username, `${password}-ready`))
      const enrollment = await run(Nodes.issueEnrollment(employee.id))
      const sync = { display_name: 'Restored workstation', system: 'linux', capabilities: [] }
      const identity = await run(
        Nodes.registerNode({ ...sync, enrollment_token: String(enrollment.enrollment_token) }, signer),
      )
      const source = {
        node_id: identity.node_id,
        employee_id: employee.id,
        credential_id: identity.credential.id,
        incarnation: randomUUID(),
        conn_id: randomUUID(),
      }
      await run(Nodes.claimConnection(source))
      await run(Nodes.syncNode(source, sync))
      await run(
        Nodes.saveRuntimeReport(source, {
          roots: [{ root_id: 'work', path: '/workspace' }],
          repos: [],
          exec: { enabled: false, shell: '/bin/sh' },
          agents: [
            {
              agent_type: 'cursor',
              status: 'available',
              version: 'offline',
              models: [],
              default_model: '',
              runtime_modes: [{ id: 'full-access', available: true }],
              default_runtime_mode: 'full-access',
              capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
            },
          ],
          project_runtime: { version: 'offline', providers: [{ provider: 'openai-codex', status: 'available' }] },
        }),
      )
      const firstMessage = randomUUID()
      const { thread } = await run(
        Threads.create(employee.id, {
          client_thread_id: randomUUID(),
          node_id: identity.node_id,
          agent_type: 'cursor',
          working_directory: '/workspace',
          message: { client_message_id: firstMessage, content: 'Preserve this input' },
        }),
      )
      const [open] = await run(Threads.claimCommands())
      await run(
        Threads.processReceipt(source, open!.message_id, {
          type: 'thread.command_result',
          thread_id: thread.id,
          ok: true,
          storage_generation: 'restore-generation',
        }),
      )
      let workerSeq = 0
      const report = (kind: P.ThreadReport['kind'], extra: Partial<P.ThreadReport> = {}, from = source) =>
        run(
          Threads.processReport(from, {
            type: 'thread.report',
            thread_id: thread.id,
            event_id: randomUUID(),
            worker_seq: ++workerSeq,
            kind,
            storage_generation: 'restore-generation',
            ...extra,
          }),
        )
      await report('thread.opened')
      const [message] = await run(Threads.claimCommands())
      await run(
        Threads.processReceipt(source, message!.message_id, {
          type: 'thread.command_result',
          thread_id: thread.id,
          ok: true,
          storage_generation: 'restore-generation',
        }),
      )
      await report('message.queued', { client_message_id: firstMessage })
      await report('turn.started', { worker_turn_seq: 1, client_message_id: firstMessage })
      await report('message.sent', { worker_turn_seq: 1, client_message_id: firstMessage })
      await report('reply', { worker_turn_seq: 1, content: 'Preserved reply' })
      await report('turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true })
      const project = await run(
        Projects.createProject(employee.id, {
          title: 'Restored project',
          goal: 'Keep saved work',
          provider: 'openai-codex',
          model: 'offline',
        }),
      )
      const memoryId = randomUUID()
      const memory = await run(
        writeProjectMemory(employee.id, project.id, memoryId, {
          operation_id: randomUUID(),
          expected_revision: 0,
          title: 'Restore rule',
          content: 'Do not repeat uncertain execution',
        }),
      )
      await run(
        Projects.acceptProjectMessage(employee.id, project.id, {
          client_message_id: randomUUID(),
          content: 'Coordinate work',
        }),
      )
      await run(Projects.scheduleProjectRun(project.agent.id))
      const [projectStart] = await run(Projects.claimProjectCommands('project_run_start'))
      expect(projectStart).toBeDefined()
      const uncertainMessage = randomUUID()
      await run(
        Threads.addMessage(employee.id, thread.id, {
          client_message_id: uncertainMessage,
          content: 'This may already have executed',
        }),
      )
      const [uncertain] = await run(Threads.claimCommands())
      expect(uncertain?.body).toMatchObject({ action: 'message', client_message_id: uncertainMessage })
      const parkedMessage = randomUUID()
      await run(
        Threads.addMessage(employee.id, thread.id, {
          client_message_id: parkedMessage,
          content: 'Keep this restored input unknown',
        }),
      )
      await run(Threads.resume(employee.id, thread.id))
      await run(Threads.stop(employee.id, thread.id))
      const history = await run(Threads.timeline(employee.id, thread.id))
      const unusedEnrollment = await run(Nodes.issueEnrollment(employee.id))

      // 只回退备份后改变的行，重现旧会话、旧凭据与已派发但未确认的旧快照。
      await run(Auth.logout(session.token))
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=${identity.credential.id}`
          yield* sql`UPDATE thread_outbox SET acked_at=clock_timestamp(),result='{"ok":true}'::jsonb WHERE message_id=${uncertain!.message_id}`
          yield* sql`UPDATE thread_messages SET status='queued' WHERE thread_id=${thread.id} AND client_message_id=${uncertainMessage}`
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE thread_outbox SET acked_at=NULL,result=NULL WHERE message_id=${uncertain!.message_id}`
              yield* sql`UPDATE thread_messages SET status='accepted' WHERE thread_id=${thread.id} AND client_message_id=${uncertainMessage}`
              yield* sql`UPDATE login_sessions SET revoked_at=NULL WHERE token_hash=${Auth.digest(session.token)}`
              yield* sql`UPDATE node_credentials SET revoked_at=NULL WHERE id=${identity.credential.id}`
            }),
          )
        }),
      )
      await run(Auth.lookupSession(session.token))
      await run(Nodes.authenticateNode(identity.credential.token, signer))
      const missingKey = join(directory, 'missing.key')
      await expect(run(finalizeRestore(missingKey))).rejects.toMatchObject({ code: 'invalid_signing_key' })
      await expect(readFile(missingKey)).rejects.toMatchObject({ code: 'ENOENT' })
      await run(Auth.lookupSession(session.token))

      const executionId = randomUUID()
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO executions(id,employee_id,project_id,node_id,origin_conversation_id,origin_tool_call_id,
          request_hash,command,working_directory,timeout_seconds,storage_generation,wait_until)
          VALUES(${executionId},${employee.id},${project.id},${identity.node_id},${project.conversation.id},'restore-exec',
            ${Buffer.from('restore')},'side-effect','/work',7200,'restore-generation',clock_timestamp())`
          yield* sql`INSERT INTO execution_outbox(execution_id,message_id,action) VALUES(${executionId},${randomUUID()},'start')`
        }),
      )
      await run(finalizeRestore(keyPath))
      const state = () =>
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql`SELECT jsonb_build_object(
          'session',(SELECT to_jsonb(s) FROM login_sessions s WHERE token_hash=${Auth.digest(session.token)}),
          'credential',(SELECT to_jsonb(c) FROM node_credentials c WHERE id=${identity.credential.id}),
          'presence',(SELECT to_jsonb(p) FROM node_presence p WHERE node_id=${identity.node_id}),
          'execution',(SELECT to_jsonb(e) FROM executions e WHERE id=${executionId}),
          'execution_outbox',(SELECT to_jsonb(o) FROM execution_outbox o WHERE execution_id=${executionId}),
          'thread',(SELECT to_jsonb(t) FROM threads t WHERE id=${thread.id}),
          'message',(SELECT to_jsonb(m) FROM thread_messages m WHERE thread_id=${thread.id} AND client_message_id=${uncertainMessage}),
          'outbox',(SELECT to_jsonb(o) FROM thread_outbox o WHERE message_id=${uncertain!.message_id}),
          'project',(SELECT to_jsonb(p) FROM projects p WHERE id=${project.id}),
          'agent',(SELECT to_jsonb(a) FROM project_agents a WHERE id=${project.agent.id}),
          'run',(SELECT to_jsonb(r) FROM agent_runs r WHERE id=${projectStart!.command.run_id}),
          'conversation',(SELECT to_jsonb(c) FROM conversations c WHERE id=${project.conversation.id})) AS value`
          }),
        )
      const finalized = await state()
      await run(finalizeRestore(keyPath))
      expect(await state()).toEqual(finalized)
      expect(await run(Threads.timeline(employee.id, thread.id))).toEqual(history)
      expect(await run(getProjectMemory(employee.id, project.id, memoryId))).toMatchObject({
        content: memory.content,
        revision: 1,
      })
      expect(await run(Threads.view({ employeeId: employee.id }, thread.id))).toMatchObject({ status: 'unknown' })
      expect(finalized[0]).toMatchObject({
        value: {
          execution: { status: 'unknown' },
          execution_outbox: { next_attempt_at: 'infinity' },
          message: { status: 'unknown', content: 'This may already have executed' },
          run: { state: 'lost' },
          project: { status: 'paused' },
        },
      })
      await expect(run(Auth.lookupSession(session.token))).rejects.toMatchObject({ code: 'unauthenticated' })
      await expect(run(Nodes.authenticateNode(identity.credential.token, signer))).rejects.toMatchObject({
        code: 'node_idle_expired',
      })
      await expect(
        run(Nodes.registerNode({ ...sync, enrollment_token: String(unusedEnrollment.enrollment_token) }, signer)),
      ).rejects.toMatchObject({ code: 'enrollment_used' })
      const freshSession = await run(Auth.login(employee.username, `${password}-ready`))
      await run(Auth.lookupSession(freshSession.token))
      const authorization = await run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))
      const restored = await run(
        Nodes.reauthenticateNode(
          identity.node_id,
          {
            operation_id: randomUUID(),
            enrollment_token: String(authorization.enrollment_token),
            previous_token: identity.credential.token,
          },
          signer,
        ),
      )
      await run(Nodes.authenticateNode(restored.credential.token, signer))
      const connected = {
        ...source,
        credential_id: restored.credential.id,
        conn_id: randomUUID(),
        incarnation: randomUUID(),
      }
      await run(Nodes.claimConnection(connected))
      await run(Nodes.syncNode(connected, sync))
      expect(await run(Nodes.getNode(employee.id, identity.node_id))).toMatchObject({
        id: identity.node_id,
        executable: true,
      })
      expect(await run(Threads.claimCommands())).toEqual([])
      await run(Projects.scheduleProjectRun(project.agent.id))
      expect(await run(Projects.claimProjectCommands('project_run_start'))).toEqual([])
      expect(await run(Threads.view({ employeeId: employee.id }, thread.id))).toMatchObject({
        status: 'unknown',
        resume_pending: false,
      })
      await run(Threads.stop(employee.id, thread.id))
      const [stop] = await run(Threads.claimCommands())
      expect(stop?.body).toMatchObject({ action: 'stop', thread_id: thread.id })
      await run(
        Threads.processReceipt(connected, stop!.message_id, {
          type: 'thread.command_result',
          thread_id: thread.id,
          ok: true,
          storage_generation: 'restore-generation',
        }),
      )
      await report('message.queued', { client_message_id: uncertainMessage }, connected)
      expect(await run(Threads.view({ employeeId: employee.id }, thread.id))).toMatchObject({ status: 'unknown' })
      await report('turn.started', { worker_turn_seq: 2, client_message_id: uncertainMessage }, connected)
      await report('message.sent', { worker_turn_seq: 2, client_message_id: uncertainMessage }, connected)
      await report('reply', { worker_turn_seq: 2, content: 'Result retained on the device' }, connected)
      await report('turn.ended', { worker_turn_seq: 2, reason: 'completed', queue_empty: true }, connected)
      await report(
        'command.completed',
        { command_id: uncertain!.message_id, command_outcome: 'succeeded', reason: '' },
        connected,
      )
      expect((await run(Threads.timeline(employee.id, thread.id, { limit: '100' }))).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'reply',
            payload: expect.objectContaining({ content: 'Result retained on the device' }),
          }),
        ]),
      )
      expect(await run(Threads.claimCommands())).toEqual([])
      await report('thread.stopped', {}, connected)
      await run(Threads.resume(employee.id, thread.id))
      const [resume] = await run(Threads.claimCommands())
      expect(resume?.body).toMatchObject({ action: 'resume', thread_id: thread.id })
      await run(
        Threads.processReceipt(connected, resume!.message_id, {
          type: 'thread.command_result',
          thread_id: thread.id,
          ok: true,
          storage_generation: 'restore-generation',
        }),
      )
      await report('thread.resumed', {}, connected)
      const newMessage = randomUUID()
      await run(
        Threads.addMessage(employee.id, thread.id, {
          client_message_id: newMessage,
          content: 'Continue in the original Thread',
        }),
      )
      const deliveries = await run(Threads.claimCommands())
      expect(
        deliveries.map(({ body }) => ({
          action: body.action,
          thread_id: body.thread_id,
          client_message_id: body.client_message_id,
        })),
      ).toEqual([{ action: 'message', thread_id: thread.id, client_message_id: newMessage }])
      expect((await run(Threads.view({ employeeId: employee.id }, thread.id))).pending_messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ client_message_id: parkedMessage, status: 'unknown' })]),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }))
