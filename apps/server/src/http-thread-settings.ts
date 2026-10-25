import type { SetThreadSettingsInput } from '@baton/protocol'
import { CurrentBrowserSession } from '@baton/protocol/http-api'
import { Effect } from 'effect'
import * as Threads from './threads/index.ts'
import { httpBusiness } from './http-security.ts'

export const setThreadSettings = (threadId: string, payload: SetThreadSettingsInput) =>
  httpBusiness(
    Effect.gen(function* () {
      const { employee } = yield* CurrentBrowserSession
      yield* Threads.setSettings(employee.id, threadId, payload)
      return yield* Threads.view({ employeeId: employee.id }, threadId)
    }),
  )
