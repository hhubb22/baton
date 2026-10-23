# @baton/sqlite

Scoped Effect 4 SqlClient for Node 26 `node:sqlite`.

`layer({ filename })` provides `effect/sql/SqlClient`. A writable file database opens with WAL, `synchronous=FULL`, foreign keys enabled, and a 5-second busy timeout. The timeout can be configured with `busyTimeoutMs`. Opening a file database fails if WAL cannot be enabled. In-memory databases use SQLite's memory journal.

One connection and one semaphore serialize statements and transactions. Connection leases use Effect's `makeSqliteAcquirers`: waiting for the permit is interruptible, and releasing it is registered before using the connection. Transactions begin with `BEGIN IMMEDIATE`, nested transactions use savepoints, and interruption rolls back before the connection is released. Failed commits attempt rollback; if cleanup fails, subsequent acquisitions must successfully retry rollback before reusing the connection. Resources close with the Effect scope. A readonly client opens the file using SQLite's readonly mode and does not change the journal or synchronization setting.

Queries support positional parameters, blobs, bigint values through `SqlClient.SafeIntegers`, row transformations, raw modification results and array results. Streaming buffers a query's result before emitting its rows. Statements are prepared per execution, so large bound values are not retained by a statement cache. This package performs synchronous SQLite work on the calling thread; the migration measurements determine whether the Worker needs a dedicated thread.

The connection integration and SQLite error adaptation follow t3code's `packages/shared/src/nodeSqliteClient.ts`. Source and license details are in [third_party/t3code](../../third_party/t3code/README.md).
