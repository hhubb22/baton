import { randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FullOutputReference, type ThreadReport, type WorkerOpenConfig } from '@baton/protocol'
import { Cause, Effect, Exit, Schema } from 'effect'
import { afterEach, expect, it } from 'vite-plus/test'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { FullOutputStore, fullOutputPageBytes } from './full-output.ts'
import { inspectWorkerLedger, openWorkerLedger, type OpenWorkerLedger, type State } from './ledger.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}
async function fixture() {
  const root = await makePrivateTempDirectory('baton-ledger-')
  roots.push(root)
  const config: WorkerOpenConfig = {
    thread_id: randomUUID(),
    node_id: randomUUID(),
    storage_generation: randomUUID(),
    agent_type: 'cursor',
    working_directory: root,
    execution_timeout_seconds: 60,
    adapter_config: {},
  }
  return { root, dbPath: join(root, 'thread.db'), config }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const withLedger = <A, E>(f: Fixture, use: (ledger: OpenWorkerLedger) => Effect.Effect<A, E>) =>
  run(Effect.scoped(openWorkerLedger({ dbPath: f.dbPath, dataDirectory: f.root }).pipe(Effect.flatMap(use))))
const reopen = (f: Fixture) => withLedger(f, (ledger) => Effect.succeed(ledger.initial))
async function seed(f: Fixture, state: Partial<State> = {}) {
  await withLedger(f, (ledger) =>
    ledger.save({ ...ledger.initial, config: f.config, phase: 'idle', opened: true, nativeId: 'native', ...state }),
  )
  await chmod(f.dbPath, 0o600)
}
function editDatabase(f: Fixture, use: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(f.dbPath)
  try {
    use(db)
  } finally {
    db.close()
  }
}
function editMeta(f: Fixture, use: (meta: Record<string, unknown>) => void) {
  editDatabase(f, (db) => {
    const meta = JSON.parse(String(db.prepare('SELECT payload FROM thread_meta WHERE id=1').get()!.payload))
    use(meta)
    db.prepare('UPDATE thread_meta SET payload=? WHERE id=1').run(JSON.stringify(meta))
  })
}
const report = (f: Fixture, fields: Partial<ThreadReport> = {}): ThreadReport => ({
  type: 'thread.report',
  thread_id: f.config.thread_id,
  storage_generation: f.config.storage_generation,
  event_id: randomUUID(),
  worker_seq: 1,
  kind: 'thread.opened',
  ...fields,
})
const command = (f: Fixture, id: string): State['commands'][string] => ({
  digest: 'command-digest',
  receipt: {
    command_id: id,
    thread_id: f.config.thread_id,
    storage_generation: f.config.storage_generation,
    action: 'message',
  },
  status: { command_id: id, state: 'accepted' },
})
const message = (id: string): State['messages'][string] => ({
  digest: 'message-digest',
  state: 'intent',
  input: { id, text: 'input', epoch: 0, operationId: randomUUID(), mode: 'queue' },
})
function tables(f: Fixture) {
  const db = new DatabaseSync(f.dbPath, { readOnly: true, allowExtension: false })
  try {
    return db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  } finally {
    db.close()
  }
}

it('round-trips all durable state and keeps the committed baseline independent of mutable snapshots', async () => {
  const f = await fixture()
  const id = randomUUID()
  let expected: State | undefined
  await withLedger(f, (ledger) =>
    Effect.gen(function* () {
      const state: State = {
        ...ledger.initial,
        config: f.config,
        phase: 'busy',
        opened: true,
        nativeId: 'native',
        turn: 1,
        activeMessage: id,
        commands: { [id]: command(f, id) },
        messages: { [id]: message(id) },
        outbox: [{ report: report(f), acked: false }],
        processes: { '42': { pid: 42, creationTime: 'first-process', role: 'agent' } },
      }
      yield* ledger.save(state)
      // 同一个对象继续变化时，差异仍与上次确认提交的编码比较。
      state.commands[id]!.status = { command_id: id, state: 'running' }
      state.messages[id]!.state = 'sent'
      state.messages[id]!.executionId = 'execution'
      state.outbox[0]!.acked = true
      state.processes['42'] = { ...state.processes['42']!, creationTime: 'replacement-process' }
      yield* ledger.save(state)
      delete state.processes['42']
      state.processes['43'] = { pid: 43, creationTime: 'next-process', role: 'agent' }
      yield* ledger.save(state)
      expected = structuredClone(state)
      state.commands[id]!.digest = 'uncommitted'
      state.messages[id]!.digest = 'uncommitted'
      state.outbox[0]!.acked = false
      state.processes['43'] = { ...state.processes['43']!, creationTime: 'uncommitted' }
    }),
  )
  expect(await reopen(f)).toEqual(expected)
  await withLedger(f, (ledger) =>
    Effect.gen(function* () {
      ledger.initial.commands[id]!.digest = 'saved-after-reopen'
      ledger.initial.messages[id]!.digest = 'saved-after-reopen'
      ledger.initial.outbox[0]!.acked = false
      delete ledger.initial.processes['43']
      yield* ledger.save(ledger.initial)
      expected = structuredClone(ledger.initial)
    }),
  )
  expect(await reopen(f)).toEqual(expected)
})

it('preserves unknown fields, incomplete intent evidence and raw UTF-16 reply evidence across reopening', async () => {
  const f = await fixture()
  const id = randomUUID()
  const evidence = {
    type: 'reply' as const,
    nativeSessionId: 'native',
    messageId: id,
    executionId: 'execution',
    id: '\ud800\0raw-id\udfff',
    text: '\ud800raw-text\0\udfff',
  }
  const extra = { future: { nested: ['b', 'a'] } }
  Object.assign(f.config, extra)
  await seed(f, {
    messages: { [id]: Object.assign(message(id), extra) },
    commands: { [id]: Object.assign(command(f, id), extra) },
    outbox: [
      Object.assign(
        { report: report(f, { kind: 'reply', content: 'display' }), acked: false, replyEvidence: evidence },
        extra,
      ),
    ],
    ...extra,
  })
  expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('valid')
  const loaded = await reopen(f)
  expect(loaded).toMatchObject(extra)
  expect(loaded.config).toMatchObject(extra)
  expect(loaded.commands[id]).toMatchObject(extra)
  expect(loaded.messages[id]).toMatchObject({ ...extra, state: 'intent' })
  expect(loaded.messages[id]?.preparation).toBeUndefined()
  expect(loaded.outbox[0]).toMatchObject(extra)
  expect(loaded.outbox[0]?.replyEvidence).toEqual(evidence)
})

it.each(['zero-byte', 'sqlite', 'commit-only', 'initialized', 'empty-meta'] as const)(
  'initializes a permitted %s empty ledger after inspection without changing it during inspection',
  async (kind) => {
    const f = await fixture()
    if (kind === 'initialized' || kind === 'empty-meta') {
      await withLedger(f, (ledger) => (kind === 'empty-meta' ? ledger.save(ledger.initial) : Effect.void))
      await chmod(f.dbPath, 0o600)
    } else {
      await writePrivateFileAtomic(f.dbPath, '')
      if (kind === 'sqlite') editDatabase(f, (db) => db.exec('PRAGMA user_version=1'))
      if (kind === 'commit-only')
        editDatabase(f, (db) =>
          db.exec('CREATE TABLE worker_commit (id INTEGER PRIMARY KEY, commit_token TEXT NOT NULL)'),
        )
    }
    const before = await readFile(f.dbPath)
    const schema = tables(f)
    expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('empty')
    expect(await readFile(f.dbPath)).toEqual(before)
    expect(tables(f)).toEqual(schema)
    const state = await reopen(f)
    expect(state).toMatchObject({
      phase: 'empty',
      opened: false,
      commands: {},
      messages: {},
      outbox: [],
      processes: {},
    })
    await seed(f)
    expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('valid')
  },
)

it('inspects a closed WAL ledger without changing the database bytes or tables', async () => {
  const f = await fixture()
  await seed(f)
  const before = await readFile(f.dbPath)
  const schema = tables(f)
  expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('valid')
  expect(await readFile(f.dbPath)).toEqual(before)
  expect(tables(f)).toEqual(schema)
})

it('does not create a missing database or its parent directory during inspection', async () => {
  const f = await fixture()
  const before = await readdir(f.root)
  expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('missing')
  expect(await inspectWorkerLedger(join(f.root, 'missing', 'thread.db'), f.config)).toBe('missing')
  expect(await readdir(f.root)).toEqual(before)
})

it.each([
  'sqlite',
  'meta-json',
  'meta-schema',
  'missing-table',
  'meta-without-config',
  'missing-native-id',
  'residual-command',
  'residual-message',
  'residual-process',
  'residual-outbox',
  'command-json',
  'command-schema',
  'command-key',
  'command-thread',
  'command-generation',
  'status-key',
  'message-json',
  'message-schema',
  'message-key',
  'outbox-json',
  'outbox-schema',
  'outbox-seq',
  'outbox-thread',
  'outbox-generation',
] as const)('rejects %s consistently on opening and inspection without repairing the database', async (kind) => {
  const f = await fixture()
  const id = randomUUID()
  await seed(f)
  if (kind === 'sqlite') await writePrivateFileAtomic(f.dbPath, 'not a SQLite database')
  else if (kind === 'meta-without-config')
    editMeta(f, (meta) => {
      delete meta.config
    })
  else if (kind === 'missing-native-id')
    editMeta(f, (meta) => {
      delete meta.nativeId
    })
  else
    editDatabase(f, (db) => {
      if (kind === 'meta-json') db.prepare('UPDATE thread_meta SET payload=?').run('{broken json')
      else if (kind === 'meta-schema') db.prepare('UPDATE thread_meta SET payload=?').run('{}')
      else if (kind === 'missing-table') db.exec('DROP TABLE thread_messages')
      else if (kind.startsWith('residual-')) {
        db.exec('DELETE FROM thread_meta')
        switch (kind) {
          case 'residual-command':
            db.prepare('INSERT INTO thread_commands VALUES (?,?)').run(id, '{}')
            break
          case 'residual-message':
            db.prepare('INSERT INTO thread_messages VALUES (?,?)').run(id, '{}')
            break
          case 'residual-process':
            db.prepare('INSERT INTO thread_processes VALUES (?,?,?)').run(42, 'created', 'agent')
            break
          case 'residual-outbox':
            db.prepare('INSERT INTO thread_outbox VALUES (?,?)').run(1, '{}')
            break
        }
      } else if (kind.startsWith('command-') || kind === 'status-key') {
        const value = command(f, id)
        if (kind === 'command-key') value.receipt = { ...value.receipt, command_id: randomUUID() }
        if (kind === 'status-key') value.status = { command_id: randomUUID(), state: 'accepted' }
        if (kind === 'command-thread') value.receipt = { ...value.receipt, thread_id: randomUUID() }
        if (kind === 'command-generation') value.receipt = { ...value.receipt, storage_generation: randomUUID() }
        db.prepare('INSERT INTO thread_commands VALUES (?,?)').run(
          id,
          kind === 'command-json' ? '{' : kind === 'command-schema' ? '{}' : JSON.stringify(value),
        )
      } else if (kind.startsWith('message-')) {
        const value = message(id)
        if (kind === 'message-key') value.input = { ...value.input, id: randomUUID() }
        db.prepare('INSERT INTO thread_messages VALUES (?,?)').run(
          id,
          kind === 'message-json' ? '{' : kind === 'message-schema' ? '{}' : JSON.stringify(value),
        )
      } else {
        const value = { report: report(f), acked: false }
        if (kind === 'outbox-seq') value.report = { ...value.report, worker_seq: 2 }
        if (kind === 'outbox-thread') value.report = { ...value.report, thread_id: randomUUID() }
        if (kind === 'outbox-generation') value.report = { ...value.report, storage_generation: randomUUID() }
        db.prepare('INSERT INTO thread_outbox VALUES (?,?)').run(
          1,
          kind === 'outbox-json' ? '{' : kind === 'outbox-schema' ? '{}' : JSON.stringify(value),
        )
      }
    })
  const before = await readFile(f.dbPath)
  const schema = kind === 'sqlite' ? undefined : tables(f)
  expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('corrupt')
  await expect(reopen(f)).rejects.toMatchObject({ code: 'ledger_corrupt' })
  expect(await readFile(f.dbPath)).toEqual(before)
  if (schema) expect(tables(f)).toEqual(schema)
})

it('compares every configuration field with sorted object keys while preserving array order', async () => {
  const f = await fixture()
  Object.assign(f.config, { future: { z: 1, a: ['first', 'second'] } })
  await seed(f)
  const reordered = Object.assign({}, f.config, { future: { a: ['first', 'second'], z: 1 } })
  expect(await inspectWorkerLedger(f.dbPath, reordered)).toBe('valid')
  for (const expected of [
    { ...f.config, thread_id: randomUUID() },
    { ...f.config, node_id: randomUUID() },
    { ...f.config, storage_generation: randomUUID() },
    { ...f.config, execution_timeout_seconds: 120 },
    Object.assign({}, f.config, { future: { a: ['second', 'first'], z: 1 } }),
    Object.assign({}, f.config, { future: { a: ['first', 'second'], z: 2 } }),
  ])
    expect(await inspectWorkerLedger(f.dbPath, expected)).toBe('corrupt')
})

it('reads committed WAL state without checkpointing or changing the schema', async () => {
  const f = await fixture()
  await seed(f)
  const db = new DatabaseSync(f.dbPath)
  try {
    db.exec('PRAGMA wal_autocheckpoint=0')
    const meta = JSON.parse(String(db.prepare('SELECT payload FROM thread_meta').get()!.payload))
    meta.config.storage_generation = randomUUID()
    db.prepare('UPDATE thread_meta SET payload=?').run(JSON.stringify(meta))
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    const names = (await readdir(f.root)).sort()
    const main = await readFile(f.dbPath)
    const wal = await readFile(f.dbPath + '-wal')
    expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('corrupt')
    expect(await inspectWorkerLedger(f.dbPath, meta.config)).toBe('valid')
    expect((await readdir(f.root)).sort()).toEqual(names)
    expect(await readFile(f.dbPath)).toEqual(main)
    expect(await readFile(f.dbPath + '-wal')).toEqual(wal)
    expect(db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual(schema)
  } finally {
    db.close()
  }
})

it('classifies a real exclusive SQLite lock as retry and succeeds after release', async () => {
  const f = await fixture()
  await seed(f)
  const db = new DatabaseSync(f.dbPath)
  try {
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE')
    expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('retry')
  } finally {
    db.exec('ROLLBACK')
    db.close()
  }
  expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('valid')
})

it.skipIf(process.platform === 'win32')('restores private ledger permissions during inspection', async () => {
  const f = await fixture()
  await seed(f)
  await chmod(f.dbPath, 0o644)
  expect(await inspectWorkerLedger(f.dbPath, f.config)).toBe('valid')
  expect((await lstat(f.dbPath)).mode & 0o777).toBe(0o600)
})

it('writes complete replies before clipping their reports and persists the same reference across saves and reopening', async () => {
  const f = await fixture()
  const text = 'START' + '正文🙂中间'.repeat(20000) + 'END'
  let saved: State | undefined
  await withLedger(f, (ledger) =>
    Effect.gen(function* () {
      const next = { ...ledger.initial, config: f.config }
      next.outbox.push({ acked: false, report: report(f, { kind: 'reply', content: text }) })
      yield* ledger.save(next)
      const published = next.outbox[0]!.report
      expect(published.truncated).toBe(true)
      expect(Buffer.byteLength(published.content ?? '')).toBeLessThanOrEqual(32768)
      const reference = Schema.decodeUnknownSync(FullOutputReference)(published.metadata?.full_output)
      expect(reference.total_bytes).toBe(Buffer.byteLength(text))
      const bytes = yield* Effect.promise(() => readFile(join(f.root, 'full-output', `${reference.id}.bin`)))
      expect(bytes).toEqual(Buffer.from(text))
      next.outbox[0]!.acked = true
      yield* ledger.save(next)
      saved = structuredClone(next)
    }),
  )
  const loaded = await reopen(f)
  expect(loaded).toEqual(saved)
  const reference = Schema.decodeUnknownSync(FullOutputReference)(loaded.outbox[0]!.report.metadata?.full_output)
  expect((await readdir(join(f.root, 'full-output'))).sort()).toEqual(
    [`${reference.id}.bin`, `${reference.id}.json`].sort(),
  )
  const result = await new FullOutputStore(f.root).read({
    type: 'session.request',
    action: 'full_output',
    operation_id: randomUUID(),
    session_id: f.config.thread_id,
    output_id: reference.id,
    storage_generation: reference.storage_generation,
    cursor: String(fullOutputPageBytes * 2),
  })
  expect(result.ok).toBe(true)
  expect(Buffer.from(result.full_output?.data ?? '', 'base64')).toEqual(
    Buffer.from(text).subarray(fullOutputPageBytes * 2, fullOutputPageBytes * 3),
  )
})

it('saves complete item JSON before clipping and retains raw identity and references after ACK and reopening', async () => {
  const f = await fixture()
  const data = { input: 'start' + '中🙂'.repeat(60000) + 'end', output: '\\0\\ud800'.repeat(30000) }
  const original = JSON.stringify(data)
  await withLedger(f, (ledger) =>
    Effect.gen(function* () {
      const next: State = {
        ...ledger.initial,
        config: f.config,
        outbox: [
          {
            acked: false,
            itemId: 'native\\0',
            report: report(f, {
              kind: 'turn.item',
              worker_turn_seq: 1,
              truncated: false,
              original_bytes: Buffer.byteLength(original),
              item: { id: 'native\\0', type: 'command_execution', status: 'completed', ordinal: 0, data },
            }),
          },
        ],
      }
      yield* ledger.save(next)
      const item = next.outbox[0]!.report
      expect(Buffer.byteLength(JSON.stringify(item.item))).toBeLessThanOrEqual(192 * 1024)
      expect(item.truncated).toBe(true)
      expect(item.original_bytes).toBe(Buffer.byteLength(original))
      const reference = Schema.decodeUnknownSync(FullOutputReference)(item.metadata?.full_output)
      expect(yield* Effect.promise(() => readFile(join(f.root, 'full-output', `${reference.id}.bin`), 'utf8'))).toBe(
        original,
      )
      next.outbox[0]!.acked = true
      yield* ledger.save(next)
    }),
  )
  const loaded = await reopen(f)
  expect(loaded.outbox[0]!.itemId).toBe('native\\0')
  expect(loaded.outbox[0]!.acked).toBe(true)
  expect(loaded.outbox[0]!.report.metadata?.full_output).toBeDefined()
  expect((await readdir(join(f.root, 'full-output'))).length).toBe(2)
})

it('leaves the committed database unchanged when complete output cannot be written and requires reopening', async () => {
  const f = await fixture()
  await seed(f)
  const previous = await reopen(f)
  await writePrivateFileAtomic(join(f.root, 'full-output'), 'blocks the output directory')
  await withLedger(f, (ledger) =>
    Effect.gen(function* () {
      const next: State = {
        ...ledger.initial,
        epoch: 1,
        outbox: [{ acked: false, report: report(f, { kind: 'reply', content: 'new complete output' }) }],
      }
      const failure = yield* ledger.save(next).pipe(Effect.flip)
      expect(failure).toMatchObject({ code: 'storage_error' })
      expect(next.outbox[0]!.report.metadata?.full_output).toBeUndefined()
      const unusable = yield* ledger.save(ledger.initial).pipe(Effect.flip)
      expect(unusable).toMatchObject({ code: 'ledger_closed' })
    }),
  )
  expect(await reopen(f)).toEqual(previous)
})

it('rolls back all state on a transaction failure and refuses to reuse the failed handle', async () => {
  const f = await fixture()
  await seed(f)
  const previous = await reopen(f)
  editDatabase(f, (db) =>
    db.exec(
      "CREATE TRIGGER reject_report BEFORE INSERT ON thread_outbox BEGIN SELECT RAISE(ABORT, 'injected report failure'); END",
    ),
  )
  await withLedger(f, (ledger) =>
    Effect.gen(function* () {
      const id = randomUUID()
      const next: State = {
        ...ledger.initial,
        epoch: 1,
        commands: { [id]: command(f, id) },
        messages: { [id]: message(id) },
        processes: { '42': { pid: 42, creationTime: 'created', role: 'agent' } },
        outbox: [{ acked: false, report: report(f) }],
      }
      expect(yield* ledger.save(next).pipe(Effect.flip)).toMatchObject({ _tag: 'SqlError' })
      expect(yield* ledger.save(ledger.initial).pipe(Effect.flip)).toMatchObject({ code: 'ledger_closed' })
    }),
  )
  expect(await reopen(f)).toEqual(previous)
})
