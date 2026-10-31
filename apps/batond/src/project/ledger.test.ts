import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeProjectLedger } from './ledger.ts'

it('does not commit empty claims and only claims cleanup again when its retry is due', async () => {
  const directory = await makePrivateTempDirectory('baton-cleanup-')
  const filename = join(directory, 'project.db')
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeProjectLedger(filename)
          const db = new DatabaseSync(filename, { readOnly: true })
          try {
            const token = () => db.prepare('SELECT commit_token FROM project_commit').get()!.commit_token
            const before = token()
            for (let index = 0; index < 5; index++) expect(yield* ledger.claim(1000)).toBeUndefined()
            expect(token()).toBe(before)
            const command = {
              type: 'project_run_start' as const,
              run_id: randomUUID(),
              lease_epoch: 1,
              provider: 'openai-codex',
            }
            yield* ledger.insert(command, true)
            expect(yield* ledger.claim(1000)).toMatchObject({ run_id: command.run_id, cleanup_attempts: 0 })
            const claimed = token()
            expect(yield* ledger.claim(1001)).toBeUndefined()
            expect(token()).toBe(claimed)
            expect(yield* ledger.claim(7000)).toMatchObject({ run_id: command.run_id, cleanup_attempts: 1 })
            yield* ledger.ack(command.run_id, command.lease_epoch)
            const acked = token()
            expect(yield* ledger.claim(100_000)).toBeUndefined()
            expect(token()).toBe(acked)
          } finally {
            db.close()
          }
        }),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
