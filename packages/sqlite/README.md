# @baton/sqlite

Scoped Effect 4 SqlClient for Node 26 `node:sqlite`.

`layer({ filename })` provides `effect/sql/SqlClient`. A writable file database opens with WAL, `synchronous=FULL`, foreign keys enabled, and a 5-second busy timeout. The timeout can be configured with `busyTimeoutMs`. Opening a file database fails if WAL cannot be enabled. In-memory databases use SQLite's memory journal.

One connection and one semaphore serialize statements and transactions. Connection leases use Effect's `makeSqliteAcquirers`: waiting for the permit is interruptible, and releasing it is registered before using the connection. Transactions begin with `BEGIN IMMEDIATE`, nested transactions use savepoints, and interruption rolls back before the connection is released. Failed commits attempt rollback; if cleanup fails, subsequent acquisitions must successfully retry rollback before reusing the connection. Resources close with the Effect scope. A readonly client opens the file using SQLite's readonly mode and does not change the journal or synchronization setting.

Queries support positional parameters, blobs, bigint values through `SqlClient.SafeIntegers`, row transformations, raw modification results and array results. Streaming buffers a query's result before emitting its rows. Statements are prepared per execution, so large bound values are not retained by a statement cache. This package performs synchronous SQLite work on the calling thread; the migration measurements determine whether the Worker needs a dedicated thread. Keep transaction bodies short and perform subprocess, network and other long-running I/O outside transactions.

## Verified commits

Enable `commitVerification` for a ledger that must resolve a lost COMMIT acknowledgement. The existing `SqlClient` service and `sql.withTransaction(effect)` API remain available:

```ts
import { CommitUnknown, layer } from '@baton/sqlite'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

const ledger = layer({
  filename: '/path/to/ledger.db',
  commitVerification: {
    writeToken: (token) => ({
      sql: 'UPDATE thread_meta SET commit_token = ? WHERE thread_id = ?',
      params: [token, 'thread-1'],
    }),
    readToken: {
      sql: 'SELECT commit_token FROM thread_meta WHERE thread_id = ?',
      params: ['thread-1'],
    },
  },
})

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO commands (id) VALUES (${'command-1'})`
      return { commandId: 'command-1' }
    }),
  )
}).pipe(
  Effect.catch((error) => {
    if (error instanceof CommitUnknown) {
      // Stop Worker execution and reconcile durable ledger state before reopening.
      return Effect.die(error)
    }
    return Effect.fail(error)
  }),
  Effect.provide(ledger),
)
```

The application supplies the tables and a stable token row; they must exist before the transaction's commit hook runs. `writeToken` must update exactly one row; `readToken` must select that same row with a string `commit_token` column. Both use native SQL and positional `params`, independent of query/result name transformations. The client generates a new UUID after the outer transaction's business effect succeeds, then writes it on the same connection before COMMIT. All outer transactions on this client use verification; nested transactions remain savepoints and share the outer commit. Keep exclusive ownership of the ledger's writes, including its token row, until the operation settles.

| Outcome | Behavior |
| --- | --- |
| Body failure or interruption | Roll back; no token write, COMMIT or verification. |
| Token write failure | Roll back if still active; no COMMIT or verification. |
| COMMIT succeeds | Return the original business result. |
| COMMIT fails while the original connection is still in a transaction | Roll back and return the original COMMIT error. |
| COMMIT fails after leaving the transaction; independent token matches | Treat the transaction as committed and return the exact original business result. |
| Independent token differs | Return the original COMMIT error. |
| Independent connection open, setup, read, token decoding or close fails | Return `CommitUnknown` and block subsequent SQL on this client. |

The independent connection opens the same file readonly, uses the configured busy timeout and reads WAL without changing journal or synchronization settings. It uses SQLite's resolved main database location, including when the writer was opened with a file URI. It closes before the original transaction releases its exclusive permit. This configuration requires a writable file database; readonly, in-memory (including memory URIs) and empty temporary databases are rejected.

`CommitUnknown` extends `SqlError`, keeps `_tag: 'SqlError'`, exposes `commitOutcome: 'unknown'`, `commitError` and `verificationCause`, and has `isRetryable === false`. Detect it with `instanceof CommitUnknown`. The affected client rejects subsequent statements, reservations and transactions with the same error. The caller must stop executing Worker commands and reconcile durable state before opening another client. The package never retries a transaction or its business effect.

Effect's transaction mask covers token writing, COMMIT, verification and finalization; waiting for the connection permit and the business effect remain interruptible. Cancellation racing with COMMIT can reach the caller after the transaction has durably committed. Recover from the ledger after interruption before deciding what to execute. `afterCommit` callbacks run once after a successful or independently verified commit and connection release, and are discarded after rollback, mismatch or unknown commit. Nested savepoint rollback also discards that savepoint's callbacks.

The connection integration and SQLite error adaptation follow t3code's `packages/shared/src/nodeSqliteClient.ts`. Source and license details are in [third_party/t3code](../../third_party/t3code/README.md).
