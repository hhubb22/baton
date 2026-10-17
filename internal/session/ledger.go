package session

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type workerDB struct {
	db        *sql.DB
	mu        sync.Mutex
	execution string
	attaches  int
	observer  *Observer
}

func openWorkerDB(path string, observer *Observer) (*workerDB, error) {
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS writes (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			note TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`); err != nil {
		db.Close()
		return nil, err
	}
	if err := chmodDB(path); err != nil {
		db.Close()
		return nil, err
	}
	w := &workerDB{db: db, observer: observer}
	if err := w.load(); err != nil {
		db.Close()
		return nil, err
	}
	return w, nil
}

func (w *workerDB) Close() error {
	if w == nil || w.db == nil {
		return nil
	}
	return w.db.Close()
}

func (w *workerDB) load() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	var execution, attaches string
	err := w.db.QueryRow(`SELECT value FROM meta WHERE key = 'execution_id'`).Scan(&execution)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	w.execution = execution
	err = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'attaches'`).Scan(&attaches)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if attaches != "" {
		fmt.Sscan(attaches, &w.attaches)
	}
	return nil
}

func (w *workerDB) Bind(taskID, executionID, agentType string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.execution != "" && w.execution != executionID {
		return ErrSessionBusy
	}
	tx, err := w.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "execution_id", executionID); err != nil {
		return err
	}
	if err := putMeta(tx, "task_id", taskID); err != nil {
		return err
	}
	if err := putMeta(tx, "agent_type", agentType); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	w.execution = executionID
	return nil
}

func (w *workerDB) Append(note string) (int64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if os.Getenv("BATON_TEST_SLOW_WRITE") == "1" && note == "slow" {
		time.Sleep(200 * time.Millisecond)
	}
	res, err := w.db.Exec(
		`INSERT INTO writes (note, created_at) VALUES (?, ?)`,
		note, time.Now().UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (w *workerDB) Attach() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.attaches++
	_, _ = w.db.Exec(`INSERT INTO meta (key, value) VALUES ('attaches', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, fmt.Sprintf("%d", w.attaches))
	return w.attaches
}

func (w *workerDB) Attaches() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.attaches
}

func putMeta(tx *sql.Tx, key, value string) error {
	_, err := tx.Exec(`INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
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
			return err
		}
	}
	return nil
}
