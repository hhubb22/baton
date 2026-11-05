/**
 * The single device ledger. Thread state machines, downlink commands, reports,
 * executions and process records all commit through this schema.
 */
export const storageBaseline = [
  'CREATE TABLE node_commit (id INTEGER PRIMARY KEY CHECK(id=1), commit_token TEXT NOT NULL)',
  "INSERT INTO node_commit VALUES (1, '')",
  `CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    storage_generation TEXT NOT NULL,
    startup_phase TEXT NOT NULL CHECK(startup_phase IN ('awaiting_open','open_attempted')),
    config_json TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    control_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE thread_commands (
    command_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    request_json TEXT,
    receipt_json TEXT,
    status_json TEXT,
    worker_json TEXT,
    result_json TEXT
  )`,
  `CREATE TABLE thread_messages (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY(thread_id, message_id)
  )`,
  `CREATE TABLE thread_outbox (
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    acked INTEGER NOT NULL DEFAULT 0,
    worker_acked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(thread_id, seq)
  )`,
  `CREATE TABLE executions (
    execution_id TEXT PRIMARY KEY,
    storage_generation TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE node_processes (
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    creation_time TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY(owner_kind, owner_id, pid)
  )`,
  'CREATE INDEX thread_commands_thread ON thread_commands(thread_id)',
  'CREATE INDEX thread_messages_thread_seq ON thread_messages(thread_id, seq)',
  'CREATE INDEX thread_outbox_pending ON thread_outbox(thread_id, seq) WHERE acked=0',
  'CREATE INDEX node_processes_owner ON node_processes(owner_kind, owner_id)',
] as const

export const commitVerification = {
  writeToken: (token: string) => ({ sql: 'UPDATE node_commit SET commit_token = ? WHERE id = 1', params: [token] }),
  readToken: { sql: 'SELECT commit_token FROM node_commit WHERE id = 1' },
} as const
