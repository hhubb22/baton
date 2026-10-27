import { Effect, Layer } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BatonHttpApi, CurrentBrowserSession } from '@baton/protocol/http-api'
import * as P from '@baton/protocol'
import * as Projects from '../project/projects.ts'
import * as Memory from '../project/memory/index.ts'
import * as Inbox from '../inbox.ts'
import { decodeResponse, httpBusiness } from './security.ts'

const current = <A, E, R>(operation: (employeeId: string) => Effect.Effect<A, E, R>) =>
  httpBusiness(
    Effect.gen(function* () {
      const { employee } = yield* CurrentBrowserSession
      return yield* operation(employee.id)
    }),
  )
const limit = (value?: string) => (value === undefined ? 50 : Number(value))
const sequence = (value?: string) => (value === undefined ? 0 : Number(value))

export const projectHttpHandlers = () =>
  Layer.mergeAll(
    HttpApiBuilder.group(BatonHttpApi, 'projects', (handlers) =>
      handlers
        .handle('list', ({ query }) =>
          current((employee) =>
            Projects.listProjects(employee, query.after_id, limit(query.limit)).pipe(
              Effect.flatMap(decodeResponse(P.ProjectsResponse)),
            ),
          ),
        )
        .handle('create', ({ payload }) =>
          current((employee) =>
            Projects.createProject(employee, payload).pipe(Effect.flatMap(decodeResponse(P.Project))),
          ),
        )
        .handle('get', ({ params }) =>
          current((employee) =>
            Projects.getProject(employee, params.projectId).pipe(Effect.flatMap(decodeResponse(P.Project))),
          ),
        )
        .handle('update', ({ params, payload }) =>
          current((employee) =>
            Projects.patchProject(employee, params.projectId, payload).pipe(Effect.flatMap(decodeResponse(P.Project))),
          ),
        )
        .handle('status', ({ params }) =>
          current((employee) =>
            Projects.projectStatus(employee, params.projectId).pipe(Effect.flatMap(decodeResponse(P.ProjectStatus))),
          ),
        )
        .handle('messages', ({ params, query }) =>
          current((employee) =>
            Projects.projectMessages(
              employee,
              params.projectId,
              query.client_message_id,
              sequence(query.after_id),
              limit(query.limit),
            ).pipe(Effect.flatMap(decodeResponse(P.ProjectMessagePage))),
          ),
        )
        .handle('addMessage', ({ params, payload }) =>
          current((employee) =>
            Projects.acceptProjectMessage(employee, params.projectId, payload).pipe(
              Effect.flatMap(decodeResponse(P.ProjectMessage)),
            ),
          ),
        )
        .handle('events', ({ params, query }) =>
          current((employee) =>
            Projects.projectEvents(employee, params.projectId, sequence(query.after_seq), limit(query.limit)).pipe(
              Effect.flatMap(decodeResponse(P.ProjectEventPage)),
            ),
          ),
        )
        .handle('stop', ({ params }) => current((employee) => Projects.stopProject(employee, params.projectId)))
        .handle('retry', ({ params }) => current((employee) => Projects.retryProject(employee, params.projectId)))
        .handle('memory', ({ params, query }) =>
          current((employee) =>
            Memory.listProjectMemory(
              employee,
              params.projectId,
              query.after_id,
              query.limit,
              query.include_inactive === 'true',
            ).pipe(Effect.flatMap(decodeResponse(P.MemoriesResponse))),
          ),
        )
        .handle('memoryTopics', ({ params }) =>
          current((employee) =>
            Memory.projectMemoryTopics(employee, params.projectId).pipe(
              Effect.flatMap(decodeResponse(P.MemoryTopicsResponse)),
            ),
          ),
        )
        .handle('memoryStatus', ({ params }) =>
          current((employee) =>
            Memory.projectMemoryStatus(employee, params.projectId).pipe(
              Effect.flatMap(decodeResponse(P.MemoryWorkStatus)),
            ),
          ),
        )
        .handle('recallMemory', ({ params, payload }) =>
          current((employee) =>
            Memory.recallProjectMemory(employee, params.projectId, payload).pipe(
              Effect.flatMap(decodeResponse(P.MemoryRecallResult)),
            ),
          ),
        )
        .handle('memorySource', ({ params, query }) =>
          current((employee) =>
            Memory.getMemorySource(employee, params.projectId, params.sourceId, query.offset, query.max_bytes).pipe(
              Effect.flatMap(decodeResponse(P.MemorySourcePage)),
            ),
          ),
        )
        .handle('changeMemory', ({ params, payload }) =>
          current((employee) =>
            Memory.changeProjectMemory(employee, params.projectId, params.memoryId, payload).pipe(
              Effect.flatMap(decodeResponse(P.ProjectMemory)),
            ),
          ),
        )
        .handle('getMemory', ({ params }) =>
          current((employee) =>
            Memory.getProjectMemory(employee, params.projectId, params.memoryId).pipe(
              Effect.flatMap(decodeResponse(P.ProjectMemory)),
            ),
          ),
        )
        .handle('writeMemory', ({ params, payload }) =>
          current((employee) =>
            Memory.writeProjectMemory(employee, params.projectId, params.memoryId, payload).pipe(
              Effect.flatMap(decodeResponse(P.ProjectMemory)),
            ),
          ),
        )
        .handle('memoryRevisions', ({ params, query }) =>
          current((employee) =>
            Memory.projectMemoryRevisions(
              employee,
              params.projectId,
              params.memoryId,
              query.after_revision,
              query.limit,
            ).pipe(Effect.flatMap(decodeResponse(P.MemoryRevisionsResponse))),
          ),
        ),
    ),
    HttpApiBuilder.group(BatonHttpApi, 'inbox', (handlers) =>
      handlers
        .handle('list', ({ query }) =>
          current((employee) => Inbox.listInbox(employee, query).pipe(Effect.flatMap(decodeResponse(P.InboxPage)))),
        )
        .handle('get', ({ params }) =>
          current((employee) =>
            Inbox.getAttentionRequest(employee, params.requestId).pipe(
              Effect.flatMap(decodeResponse(P.AttentionRequest)),
            ),
          ),
        )
        .handle('answer', ({ params, payload }) =>
          current((employee) =>
            Inbox.handleAttentionRequest(employee, params.requestId, payload).pipe(
              Effect.flatMap(decodeResponse(P.AttentionRequest)),
            ),
          ),
        )
        .handle('close', ({ params, payload }) =>
          current((employee) =>
            Inbox.handleAttentionRequest(employee, params.requestId, payload, true).pipe(
              Effect.flatMap(decodeResponse(P.AttentionRequest)),
            ),
          ),
        ),
    ),
  )
