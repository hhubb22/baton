import { randomUUID } from 'node:crypto'
import { expect, it } from 'vite-plus/test'
import { withTestDatabase } from '../testing/database.ts'
import { projectToolFixture } from '../testing/project-tools.ts'
import { contextualRuntimeRequest } from '../testing/project-context.ts'
import { runtimeRequest } from './runtime.ts'
import { projectStatus } from './view.ts'

it('publishes a preview until the assistant reply is saved', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const events: unknown[] = []
    const base = { type: 'project_runtime.request' as const, run_id: c.runId, lease_epoch: c.leaseEpoch }
    await db.run(
      runtimeRequest(
        c.source,
        { ...base, operation: 'preview', last_seq: 1, payload: { text: 'A live reply', truncated: false } },
        (event) => events.push(event),
      ),
    )
    expect(events).toEqual([{ type: 'project.changed', project_id: c.projectId, change: 'detail' }])
    expect(await db.run(projectStatus(c.employeeId, c.projectId))).toMatchObject({
      state: 'running',
      last_seq: 1,
      preview: { after_seq: 1, text: 'A live reply', truncated: false },
    })
    await db.run(
      contextualRuntimeRequest(c.source, {
        ...base,
        operation: 'append_event',
        last_seq: 1,
        client_event_id: randomUUID(),
        payload: {
          format: 'pi-ai/1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'A live reply' }] },
        },
      }),
    )
    expect(await db.run(projectStatus(c.employeeId, c.projectId))).toMatchObject({
      last_seq: 2,
      preview: null,
    })
  }))
