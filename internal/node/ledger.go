package node

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"baton/internal/identity"

	_ "modernc.org/sqlite"
)

var agentName = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)

// Ledger 是 batond 独占写入的节点账本。关键映射先落在这里，然后才通知 Worker。
type Ledger struct {
	db         *sql.DB
	dir        string
	generation string
}

func OpenLedger(dir string) (*Ledger, error) {
	if err := PrepareDataDir(dir); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "node.db")
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, fmt.Errorf("无法打开节点账本: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("无法打开节点账本: %w", err)
	}
	if err := checkSQLite(db); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(nodeSchema + threadSchema); err != nil {
		db.Close()
		return nil, errors.New("无法创建节点账本")
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

func (l *Ledger) WorkerSessions() ([]string, error) {
	rows, err := l.db.Query(`SELECT session_id FROM threads WHERE status = 'ready' ORDER BY session_id`)
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

func containsCap(caps []string, agent string) bool {
	for _, cap := range caps {
		if cap == agent {
			return true
		}
	}
	return false
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
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path), OmitHost: !filepath.IsAbs(path)}
	if filepath.IsAbs(path) && !strings.HasPrefix(u.Path, "/") {
		u.Path = "/" + u.Path
	}
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
CREATE TABLE IF NOT EXISTS workers (
    session_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_runtime_runs (
    run_id TEXT PRIMARY KEY,
    lease_epoch INTEGER NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    cleanup_complete INTEGER NOT NULL DEFAULT 0,
    cleanup_acked INTEGER NOT NULL DEFAULT 0,
    cleanup_next_at INTEGER NOT NULL DEFAULT 0,
    cleanup_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS project_runtime_cleanup_due
    ON project_runtime_runs(cleanup_next_at,run_id)
    WHERE cleanup_complete=1 AND cleanup_acked=0;
`
