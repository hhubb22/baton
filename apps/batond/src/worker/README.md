# Thread Worker

`makeWorker({ dbPath, agentFactory, recoverProcesses? })` returns a scoped Effect. Construction opens and loads the SQLite ledger; native process recovery, open, resume, preparation and send run in background fibers. The caller owns authentication, the exclusive Worker lock and the IPC listener.

```ts
const worker = yield* makeWorker({ dbPath, agentFactory })
yield* listenWorker({ endpoint, token, handle: worker.handle })
yield* worker.failed
```

`handle(request)` accepts `WorkerRequest` and returns `Effect<WorkerIPCMessage, WorkerFailure>`. `worker.failed` is an `Effect<never, WorkerFailure>` that fails when execution freezes; the owner waits on it so the outer Scope closes and releases the process lock. `status.worker_ready` describes the Worker, while `agent_ready` describes a successfully opened or resumed Agent. Opening and resuming return durable receipts before the native operation finishes. Storage failures stop execution and fail subsequent requests; the owner must close the scope and reopen the ledger to reconcile durable facts.

## Agent integration

[agent.ts](agent.ts) defines the Effect interface. Each factory call constructs a fresh instance without I/O. Instances may become terminal after abort, close or reap. The Worker creates another instance for resume and for read-only input evidence after process reaping.

- `open` and `resume` persist the native mapping before returning its identity.
- `prepareInput` supplies one durable baseline, encoded within 4 KiB. The Worker saves it with intent and passes the same baseline to `send`.
- `restoreInput` only restores local preparation state. `sent` reads native evidence and never submits an input or starts an execution session.
- `send` returns native acceptance evidence. Replies and turn termination use the independent event stream; they may arrive before acceptance.
- `abort` records cancellation independently of a pending open or send. `reap` confirms the whole process tree and excludes late resource creation from cancelled startup.
- Reply identity and the native session, input and execution IDs determine event ownership. Old instance events and ended-turn events cannot become output for a new turn.

T1 supports queued messages. `steer` receives an explicit unsupported response. A failed open or resume runs bounded close/reap cleanup before its failure is completed. Confirmed cleanup retires the instance; retries obtain a fresh instance. Unconfirmed cleanup leaves the Thread unknown and prevents execution until process reaping is confirmed.

## Process records

`worker.records.add(record)`, `remove(record)` and `list()` return Effects. Records use the platform `ProcessRecord` type with `pid`, `creationTime` and `role`; `thread_processes.created_at` stores `creationTime`. Removal checks the complete identity so a stale cleanup cannot delete a reused PID's record.

`recoverProcesses(records)` returns `Effect<{ processTreeStopped: boolean }, AgentError>`. It runs in a background fiber and can call the record methods while the state queue continues to accept status and stop requests. It must confirm recovery before the Worker starts an execution Agent. Stop takes over an interrupted recovery by reading the remaining durable records and obtaining recovery evidence for them; an empty Agent instance cannot establish that those recorded processes have stopped. Persisted records without a recovery callback produce an unknown outcome.

An adapter using Promise callbacks can bridge them with `Effect.runPromise(worker.records.add(record))` and `Effect.runPromise(worker.records.remove(record))`. Record callbacks remain available during scoped Agent cleanup, before SQLite closes.

## Persistence and recovery

The Worker alone owns the ledger. `@baton/sqlite` supplies WAL, FULL synchronization and commit verification. A serial queue runs short state transitions and transactions; slow I/O runs in scoped fibers. Control epochs and operation IDs reject stale completions.

Commands bind their ID to a content digest and immutable receipt. Distinct command IDs for the same message share its execution result; conflicting message content is rejected. Business reports precede `command.completed` in the same transaction. The outbox retains stable report IDs and sequences until acknowledgment. Reports fit within 120 KiB of encoded JSON and a pending response fits within 240 KiB; shortened text carries its original UTF-8 byte count and truncation flag.

On reopen, queued inputs can resume from their durable native mapping. Persisted intent is restored and checked with read-only evidence, and is never automatically sent again. An interrupted first open without a committed Worker mapping becomes unknown. A cancelled first open cannot resume or create another native session. Stop withdraws queued messages, invalidates pending execution results and uses turn termination or process reaping as evidence. An uncertain outcome remains unknown after a later process exit.

A new message on a stopped Thread requests resume of its existing native session. On uncertainty, the Worker withdraws the previous queued inputs, reaps the old execution tree and checks pending intent through a separate read-only instance. A subsequent explicit new message or resume may restore the same native session after reaping is confirmed. Existing unknown inputs keep their result; old queue entries and intents are never revived. Missing native mappings and failed process recovery reject continuation with a reason.

Each accepted Turn uses `execution_timeout_seconds` from the open configuration. Elapsed time is the maximum of the monotonic interval and wall-clock interval, so sleep counts and a clock rollback cannot extend the limit. A scoped timer records a durable timeout stop and uses the same cancellation/reaping path as an explicit stop. The Turn ends with reason `timeout`, including when reaping produces an unknown execution outcome.

## Verification

Run from the repository root:

```sh
pnpm --dir apps/batond exec vitest run --config ../../vitest.config.ts src/worker/index.test.ts
pnpm --dir apps/batond typecheck
pnpm exec eslint apps/batond/src/worker
```

The tests use real temporary SQLite files and controllable Agents. They cover receipts and conflicts, queued turns, cancellation, event ownership, Scope recovery, process record recovery, bounded outbox delivery, Turn timeouts, explicit continuation after uncertainty and commit uncertainty. Platform process-tree behavior, authenticated IPC and real Cursor execution are exercised by their integration owners.
