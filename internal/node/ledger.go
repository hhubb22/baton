package node

import (
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"baton/internal/identity"
	"baton/internal/task"

	_ "modernc.org/sqlite"
)

var agentName = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)

// Ledger 是 batond 独占写入的节点账本。关键映射先落在这里，然后才通知 Worker。
type Ledger struct {
	db         *sql.DB
	dir        string
	generation string
}

type PrepareInput struct {
	MessageID         string
	TaskID            string
	ExecutionID       string
	TaskVersion       int
	StorageGeneration string
	QueueExpiresAt    time.Time
	AgentType         string
	TargetSessionID   string
	WorkingDirectory  string
	Capabilities      []string
}

// PrepareReport 是本地准备的结果。Silent 为 true 时调用方不能回 ACK。
type PrepareReport struct {
	Silent            bool
	OK                bool
	Code              string
	Message           string
	TaskID            string
	ExecutionID       string
	SessionID         string
	StorageGeneration string
}

type savedReceipt struct {
	executionID string
	sessionID   string
	generation  string
}

func OpenLedger(dir string) (*Ledger, error) {
	if err := PrepareDataDir(dir); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "node.db")
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, errors.New("无法打开节点账本")
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, errors.New("无法打开节点账本")
	}
	if err := checkSQLite(db); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(nodeSchema); err != nil {
		db.Close()
		return nil, errors.New("无法创建节点账本")
	}
	if err := ensureReceiptExpiry(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := chmodDB(path); err != nil {
		db.Close()
		return nil, err
	}
	generation, err := ensureGeneration(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Ledger{db: db, dir: dir, generation: generation}, nil
}

func (l *Ledger) Close() error {
	if l == nil || l.db == nil {
		return nil
	}
	return l.db.Close()
}

func (l *Ledger) Generation() string {
	if l == nil {
		return ""
	}
	return l.generation
}

func (l *Ledger) HasWorker(sessionID string) (bool, error) {
	var n int
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM workers WHERE session_id = ?`, sessionID).Scan(&n); err != nil {
		return false, errors.New("无法读取 Worker 索引")
	}
	return n > 0, nil
}

func (l *Ledger) WorkerSessions() ([]string, error) {
	rows, err := l.db.Query(`SELECT session_id FROM workers ORDER BY session_id`)
	if err != nil {
		return nil, errors.New("无法读取 Worker 索引")
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, errors.New("无法读取 Worker 索引")
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("无法读取 Worker 索引")
	}
	return out, nil
}

func (l *Ledger) TaskForSession(sessionID string) (string, string, bool, error) {
	var taskID, executionID string
	err := l.db.QueryRow(`SELECT task_id, execution_id FROM receipts WHERE session_id = ?`, sessionID).Scan(&taskID, &executionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, errors.New("无法读取执行映射")
	}
	return taskID, executionID, true, nil
}

func (l *Ledger) RememberWorker(sessionID string, pid int) error {
	if _, err := identity.ParseUUID(sessionID); err != nil || pid <= 0 {
		return errors.New("Worker 索引无效")
	}
	_, err := l.db.Exec(`
		INSERT INTO workers (session_id, pid, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET pid = excluded.pid, updated_at = excluded.updated_at`,
		sessionID, pid, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return errors.New("无法记录 Worker")
	}
	return nil
}

// Prepare 先把 task_id 到 execution_id 的映射写入账本，再调用 bind。写入失败或 bind 失败时不产生可回执的成功结果。
func (l *Ledger) Prepare(in PrepareInput, bind func(sessionID string) error) PrepareReport {
	if failPersist() {
		return PrepareReport{Silent: true}
	}
	if _, err := identity.ParseUUID(in.TaskID); err != nil {
		return rejected(task.CodeInvalidTarget, "任务标识不正确")
	}
	if _, err := identity.ParseUUID(in.ExecutionID); err != nil {
		return rejected(task.CodeInvalidTarget, "执行标识不正确")
	}
	if in.TaskVersion < 1 || !agentName.MatchString(in.AgentType) {
		return rejected(task.CodeUnsupported, "节点不支持该 Agent")
	}
	existing, found, err := l.lookup(in.TaskID)
	if err != nil {
		return PrepareReport{Silent: true}
	}
	if found {
		return l.finishExisting(existing, in.TaskID, bind)
	}
	if !in.QueueExpiresAt.IsZero() && !in.QueueExpiresAt.After(time.Now()) {
		return rejected(task.CodeQueueTimeout, "排队等待已到期，不能再准备")
	}
	if in.StorageGeneration != "" && in.StorageGeneration != l.generation {
		return rejected(task.CodeInvalidTarget, "存储代次不匹配")
	}
	if !containsCap(in.Capabilities, in.AgentType) {
		return rejected(task.CodeUnsupported, "节点不支持该 Agent")
	}
	if message, ok := checkDirectory(in.WorkingDirectory); !ok {
		return rejected(task.CodeInvalidTarget, message)
	}
	sessionID := in.TargetSessionID
	if sessionID == "" {
		sessionID, err = identity.NewUUID()
		if err != nil {
			return PrepareReport{Silent: true}
		}
	} else if _, err := identity.ParseUUID(sessionID); err != nil {
		return rejected(task.CodeInvalidTarget, "Session 标识不正确")
	}
	report, err := l.insertReceipt(in, sessionID)
	if err != nil {
		return PrepareReport{Silent: true}
	}
	if !report.OK || report.Silent {
		return report
	}
	return l.finishExisting(savedReceipt{executionID: report.ExecutionID, sessionID: report.SessionID, generation: report.StorageGeneration}, in.TaskID, bind)
}

func (l *Ledger) finishExisting(saved savedReceipt, taskID string, bind func(string) error) PrepareReport {
	if bind != nil {
		if err := bind(saved.sessionID); err != nil {
			if errors.Is(err, errHistoryUnreadable) {
				return rejected(task.CodeUnavailable, "本地 Session 历史缺失或无法读取，不能继续准备")
			}
			return PrepareReport{Silent: true}
		}
	}
	if consumeDrop() {
		return PrepareReport{Silent: true}
	}
	return PrepareReport{
		OK:                true,
		TaskID:            taskID,
		ExecutionID:       saved.executionID,
		SessionID:         saved.sessionID,
		StorageGeneration: saved.generation,
	}
}

func (l *Ledger) lookup(taskID string) (savedReceipt, bool, error) {
	var saved savedReceipt
	err := l.db.QueryRow(`
		SELECT execution_id, session_id, storage_generation
		FROM receipts WHERE task_id = ?`, taskID).Scan(&saved.executionID, &saved.sessionID, &saved.generation)
	if errors.Is(err, sql.ErrNoRows) {
		return savedReceipt{}, false, nil
	}
	if err != nil {
		return savedReceipt{}, false, err
	}
	return saved, true, nil
}

func (l *Ledger) insertReceipt(in PrepareInput, sessionID string) (PrepareReport, error) {
	tx, err := l.db.Begin()
	if err != nil {
		return PrepareReport{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var existingExec, existingSession, existingGen string
	err = tx.QueryRow(`SELECT execution_id, session_id, storage_generation FROM receipts WHERE task_id = ?`, in.TaskID).
		Scan(&existingExec, &existingSession, &existingGen)
	if err == nil {
		if err := tx.Commit(); err != nil {
			return PrepareReport{}, err
		}
		return PrepareReport{OK: true, TaskID: in.TaskID, ExecutionID: existingExec, SessionID: existingSession, StorageGeneration: existingGen}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PrepareReport{}, err
	}
	var otherTask string
	err = tx.QueryRow(`SELECT task_id FROM receipts WHERE execution_id = ?`, in.ExecutionID).Scan(&otherTask)
	if err == nil {
		return rejected(task.CodeInvalidTarget, "执行标识已经属于其他任务"), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PrepareReport{}, err
	}
	if in.TargetSessionID != "" {
		var agent string
		var bound sql.NullString
		err = tx.QueryRow(`SELECT agent_type, bound_execution_id FROM sessions WHERE session_id = ?`, sessionID).Scan(&agent, &bound)
		if errors.Is(err, sql.ErrNoRows) {
			return rejected(task.CodeInvalidTarget, "节点上没有这个 Session"), nil
		}
		if err != nil {
			return PrepareReport{}, err
		}
		if agent != in.AgentType {
			return rejected(task.CodeUnsupported, "Session 的 Agent 类型与任务不一致"), nil
		}
		if bound.Valid && bound.String != "" && bound.String != in.ExecutionID {
			return rejected(task.CodeSessionBusy, "Session 正在执行其他任务"), nil
		}
		res, err := tx.Exec(`
			UPDATE sessions SET bound_execution_id = ?
			WHERE session_id = ? AND (bound_execution_id IS NULL OR bound_execution_id = ?)`,
			in.ExecutionID, sessionID, in.ExecutionID)
		if err != nil {
			return PrepareReport{}, err
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return rejected(task.CodeSessionBusy, "Session 正在执行其他任务"), nil
		}
	} else {
		if _, err := tx.Exec(`
			INSERT INTO sessions (session_id, agent_type, bound_execution_id, created_at)
			VALUES (?, ?, ?, ?)`,
			sessionID, in.AgentType, in.ExecutionID, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return PrepareReport{}, err
		}
	}
	if _, err := tx.Exec(`
		INSERT INTO receipts (
			task_id, execution_id, message_id, session_id, agent_type, storage_generation, task_version,
			queue_expires_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.TaskID, in.ExecutionID, in.MessageID, sessionID, in.AgentType, l.generation, in.TaskVersion,
		in.QueueExpiresAt.UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return PrepareReport{}, err
	}
	if err := tx.Commit(); err != nil {
		return PrepareReport{}, err
	}
	return PrepareReport{OK: true, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: sessionID, StorageGeneration: l.generation}, nil
}

func rejected(code, message string) PrepareReport {
	return PrepareReport{OK: false, Code: code, Message: message}
}

func containsCap(caps []string, agent string) bool {
	for _, cap := range caps {
		if cap == agent {
			return true
		}
	}
	return false
}

func checkDirectory(path string) (string, bool) {
	if path == "" {
		return "", true
	}
	if !filepath.IsAbs(path) {
		return "工作目录必须是绝对路径", false
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "工作目录不可用", false
	}
	return "", true
}

func ensureReceiptExpiry(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(receipts)`)
	if err != nil {
		return errors.New("无法读取节点账本")
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return errors.New("无法读取节点账本")
		}
		if name == "queue_expires_at" {
			return nil
		}
	}
	if _, err := db.Exec(`ALTER TABLE receipts ADD COLUMN queue_expires_at TEXT NOT NULL DEFAULT ''`); err != nil {
		return errors.New("无法创建节点账本")
	}
	return nil
}

// QueueExpiry 返回准备时保存的排队到期时间。
func (l *Ledger) QueueExpiry(taskID string) (time.Time, error) {
	var raw string
	err := l.db.QueryRow(`SELECT queue_expires_at FROM receipts WHERE task_id = ?`, taskID).Scan(&raw)
	if err != nil {
		return time.Time{}, err
	}
	expires, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, err
	}
	return expires.UTC(), nil
}

func ensureGeneration(db *sql.DB) (string, error) {
	var value string
	err := db.QueryRow(`SELECT value FROM meta WHERE key = 'storage_generation'`).Scan(&value)
	if err == nil && value != "" {
		return value, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("无法读取存储代次")
	}
	value, err = identity.NewUUID()
	if err != nil {
		return "", errors.New("无法创建存储代次")
	}
	if _, err := db.Exec(`INSERT INTO meta (key, value) VALUES ('storage_generation', ?)`, value); err != nil {
		return "", errors.New("无法创建存储代次")
	}
	return value, nil
}

func checkSQLite(db *sql.DB) error {
	var mode string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || !strings.EqualFold(mode, "wal") {
		return errors.New("节点账本没有使用 WAL")
	}
	var syncMode int64
	if err := db.QueryRow(`PRAGMA synchronous`).Scan(&syncMode); err != nil || syncMode < 2 {
		return errors.New("节点账本没有使用 FULL 同步")
	}
	return nil
}

func sqliteDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	u.RawQuery = "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_txlock=immediate"
	return u.String()
}

func chmodDB(path string) error {
	for _, name := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(name); err != nil {
			continue
		}
		if err := os.Chmod(name, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return errors.New("无法限制节点账本的权限")
		}
	}
	return nil
}

const nodeSchema = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
    task_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    storage_generation TEXT NOT NULL,
    task_version INTEGER NOT NULL,
    queue_expires_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    bound_execution_id TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
    session_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
`

var dropState struct {
	once sync.Once
	left atomic.Int32
}

// errHistoryUnreadable 表示已知 Session 的账本缺失或损坏，准备必须明确拒绝，不能一直不回 ACK。
var errHistoryUnreadable = errors.New("本地 Session 历史缺失或无法读取")

func failPersist() bool {
	return os.Getenv("BATON_TEST_FAIL_PERSIST") == "1"
}

func consumeDrop() bool {
	dropState.once.Do(func() {
		n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("BATON_TEST_DROP_PREPARE_ACKS")))
		if err == nil && n > 0 {
			dropState.left.Store(int32(n))
		}
	})
	for {
		cur := dropState.left.Load()
		if cur <= 0 {
			return false
		}
		if dropState.left.CompareAndSwap(cur, cur-1) {
			return true
		}
	}
}
