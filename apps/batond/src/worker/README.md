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
- `end` distinguishes completed, cancelled and failed turns. Failed events carry a safe reason; the Worker persists `turn.ended` with `reason: "failed"` and the explanation in `content`. The accepted input stays sent, and the same Agent instance and native session execute queued messages. With no queued input, the Thread returns to idle.
- `question` and `question.resolved` carry the same execution identity as replies. The Worker persists each question before reporting it. `thread_answer` binds an explicit answer or cancellation to that request; the Agent's optional `answer` method returns it through the existing live session. Stop, turn completion and startup recovery close pending questions. An interrupted answer intent is never replayed.
- `abort` records cancellation independently of a pending open or send. `reap` confirms the whole process tree and excludes late resource creation from cancelled startup.
- Reply identity and the native session, input and execution IDs determine event ownership. Old instance events and ended-turn events cannot become output for a new turn.

The Worker supports queued messages and accepts `steer` when the Agent catalog reports it (Pi and Codex). Steering persists the active target turn with the queued input, checks that target before writing intent, and submits through the adapter without starting another Worker turn. A terminal event that overtakes a pending steering response is buffered until acceptance is recorded, so message.sent reaches the coordinator while the target turn is still open. A failed steering submission becomes unknown because text presence in a snapshot cannot establish which native turn received it. Cursor and Kiro reject steering. A failed open or resume runs bounded close/reap cleanup before its failure is completed. Confirmed cleanup retires the instance; retries obtain a fresh instance. Unconfirmed cleanup leaves the Thread unknown and prevents execution until process reaping is confirmed.

## Real-time output

An Agent can expose an optional `output` stream of text and complete running-step snapshots identified by `nativeSessionId`, `messageId` and `executionId`. These are consumed outside the serial state queue and never written to the ledger or outbox. The Worker checks the current Agent instance and active input/execution before accepting output, including output arriving before native input acceptance. Snapshots retain at most 32 steps and 64 KiB, preferring the highest ordinals and clipping long strings when necessary. Completed items are removed from snapshots even if an older snapshot arrives late. Replies and lifecycle events retain their durable path.

`handle({ type: "session_request", ok: true, session_request: { type: "session.request", operation_id, session_id, action: "output", cursor? } })` returns `{ type: "result", ok, session_result }`. The nested `SessionResult` echoes the operation and session IDs and includes `ok`, `state`, `text`, `cursor`, `gap`, `running_steps` and `running_steps_truncated` on success. A busy Worker reports `state: "running"`. Thread history is read from records saved by the center.

The current Turn retains at most 256 KiB of UTF-8 text. Each read returns at most 16 KiB and advances an `epoch:byteOffset` cursor on a character boundary. Old epochs, offsets outside retained text and upstream text loss resume at the retained start with `gap: true`; malformed cursors or offsets inside a retained UTF-8 character return `invalid_cursor`. Starting or ending a Turn clears text and changes the epoch; a Worker restart also starts a new epoch. Output requests do not enqueue a state transition.

## Full output

Agent replies that require clipping are saved before report clipping. Shell stdout and stderr are written from their original chunks in arrival order, before the first/last 16 KB summary is formed. The default report budgets remain 32 KB of reply text and 120 KB of encoded report JSON. Reports and center timeline events retain `metadata.full_output` with the output ID, storage generation, original byte count and expiration time. Full bytes stay on the device under `threads/<thread-id>/full-output/`; the Worker ledger and center retain the bounded reply and reference.

The device configuration file `<data-directory>/output-retention.json` accepts `{ "retention_days": 30 }`. The default is **30 days**; allowed values are integers from 1 to 3650. New outputs use the value when saved; existing outputs keep their recorded expiration. The file must have the same private permissions as other device configuration files. An invalid configuration fails saving new output with a storage error.

The daemon deletes expired files on startup and every hour, including for inactive Threads. Reads reject expired content immediately and delete it. Incomplete writes without published metadata are removed after 24 hours without writes once the Worker is no longer running. Cleanup requires the daemon to be running; after an offline period it resumes at startup.

`GET /api/v1/threads/:threadId/output?action=full_output&output_id=<id>&storage_generation=<generation>&cursor=<byte-offset>` performs an authenticated, on-demand read. The center checks employee ownership and routes the request to the Thread's device. The daemon checks Thread ID, storage generation, output ID, expiration, private directory/file ownership and permissions, and rejects symbolic links and POSIX hard links. The daemon reads directly from saved files, so a stopped Worker can still serve output. The device must be online and synchronized.

Each response contains at most **12 KB of original bytes**, base64 encoded in `session.result.full_output.data`, plus `offset`, `next_offset`, `total_bytes`, `done`, and the output identity and expiration. `cursor` is a decimal byte offset starting at `0`; malformed or out-of-range offsets fail. Base64 preserves binary data and UTF-8 characters split across pages. Consumers decode UTF-8 with a streaming decoder. The web reader retains one page, supports reading the next part and restarting, and downloads the current part as raw bytes.

## Process records

`worker.records.add(record)`, `remove(record)` and `list()` return Effects. Records use the platform `ProcessRecord` type with `pid`, `creationTime` and `role`; `thread_processes.created_at` stores `creationTime`. Removal checks the complete identity so a stale cleanup cannot delete a reused PID's record.

`recoverProcesses(records)` returns `Effect<{ processTreeStopped: boolean }, AgentError>`. It runs in a background fiber and can call the record methods while the state queue continues to accept status and stop requests. It must confirm recovery before the Worker starts an execution Agent. Stop takes over an interrupted recovery by reading the remaining durable records and obtaining recovery evidence for them; an empty Agent instance cannot establish that those recorded processes have stopped. Persisted records without a recovery callback produce an unknown outcome.

An adapter using Promise callbacks can bridge them with `Effect.runPromise(worker.records.add(record))` and `Effect.runPromise(worker.records.remove(record))`. Record callbacks remain available during scoped Agent cleanup, before SQLite closes.

## Persistence and recovery

The Worker alone owns the ledger. `openWorkerLedger({ dbPath, dataDirectory? })` validates the existing structure before initialization and returns an opening snapshot, `initial`, and `save(next)`. The ledger retains an encoded baseline independent of caller mutations and advances it only after a confirmed commit. Replies that require clipping reach the full output store before their reports are clipped and the six ledger tables commit together. Any failed save invalidates the handle; close its Scope before reopening. `@baton/sqlite` supplies WAL, FULL synchronization and commit verification, and `CommitUnknown` reaches the Worker unchanged so it can freeze execution. A serial queue runs short state transitions and transactions; slow I/O runs in scoped fibers. Control epochs and operation IDs reject stale completions.

`inspectWorkerLedger(dbPath, expectedConfig)` is the read-only recovery interface. It shares the opening decoder, preserves unknown JSON fields and raw reply evidence, and returns `valid`, `missing`, `empty`, `corrupt` or `retry`. It checks private file permissions and reads the actual WAL state without initialization, repair or checkpoint. Missing business tables, residual activity without metadata and invalid identities are corruption; locks, permission failures and uncertain I/O remain retryable. The daemon consumes this result and owns the recovery decision.

Commands bind their ID to a content digest and immutable receipt. Distinct command IDs for the same message share its execution result; conflicting message content is rejected. Business reports precede `command.completed` in the same transaction. Every `turn.ended` includes `queue_empty` from that transaction: the coordinator uses it to select idle when no queued input remains, or running while another input waits. The outbox retains stable report IDs and sequences until acknowledgment. Reports fit within 120 KiB of encoded JSON and a pending response fits within 240 KiB; shortened text carries its original UTF-8 byte count and truncation flag.

On reopen, ordinary Agents first reclaim persisted process records and the old execution instance. Confirmed recovery ends any unfinished sent input with a durable turn.ended report, then resumes the native mapping when queued inputs or an explicit request require it. Shell follows a separate path: reclaim old processes, verify the matching completion record and replay its reply and end; missing evidence leaves the outcome unknown. Persisted intent is restored and checked with read-only evidence, and is never automatically sent again. An interrupted first open without a committed Worker mapping becomes unknown. A cancelled first open cannot resume or create another native session. Stop withdraws queued messages and invalidates pending execution results. After waiting for termination evidence, it still reaps the execution instance and persisted process records; only confirmed cleanup and known input outcomes produce thread.stopped. An uncertain outcome remains unknown after a later process exit.

An explicit failed turn does not enter unknown or trigger process reaping. Broken event streams, unconfirmed sends and host crashes or connection loss still use the uncertainty path. Questions wait for an explicit answer within the active Turn's execution budget. An unconfirmed answer records an unknown command outcome and closes the question without resending the original input.

A new message on a stopped Thread requests resume of its existing native session. On uncertainty, the Worker withdraws the previous queued inputs, reaps the old execution tree and checks pending intent through a separate read-only instance. A subsequent explicit new message or resume may restore the same native session after reaping is confirmed. Existing unknown inputs keep their result; old queue entries and intents are never revived. Missing native mappings and failed process recovery reject continuation with a reason.

Each accepted Turn uses `execution_timeout_seconds`, initially 7200 seconds unless configured otherwise. `ExecutionTimeoutSeconds` accepts integers from 1 to 2147483647. A durable `thread_settings` command updates the stored configuration and records its completion in the same transaction; retries return the original receipt. Active Turns use the new total budget from their original start, and future Turns inherit it. A Turn already stopping continues to stop. Elapsed time is the maximum of the monotonic interval and wall-clock interval, so sleep counts and a clock rollback cannot extend the limit. The scoped timer sleeps at most one second at a time, records a durable timeout stop and uses the same cancellation/reaping path as an explicit stop. The Turn ends with reason `timeout`, including when reaping produces an unknown execution outcome.

## Verification

Deployment and device setup are documented in the [root README](../../../../README.md); verification commands are maintained in [AGENTS.md](../../../../AGENTS.md#常用构建与验证命令).

The tests use real temporary SQLite files and controllable Agents. `ledger.test.ts` owns the persistent-format matrix, opening and inspection agreement, immutable save baselines, full output save ordering and read-only inspection checks. Kiro's offline provider-error and derived authentication-error transcripts also exercise the real host and Worker: failed turns retain safe reasons, inputs stay sent, queued messages receive replies, and the same process and native session remain available. The Worker tests cover receipts and conflicts, queued turns, cancellation, event ownership, Scope recovery, process record recovery, bounded outbox delivery, Turn timeouts, explicit continuation after uncertainty, commit uncertainty, UTF-8 cursors, bounded output, upstream gaps and stop responsiveness during output floods. Platform process-tree behavior, authenticated IPC and real Cursor execution are exercised by their integration owners.
