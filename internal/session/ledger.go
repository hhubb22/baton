package session

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/startpermit"

	_ "modernc.org/sqlite"
)

type workerDB struct {
	db        *sql.DB
	mu        sync.Mutex
	execution string
	task      string
	nonce     string
	armedMono int64
	intent    bool
	cancelled bool
	attaches  int
	observer  *Observer
	clock     *startpermit.Clock
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
	w := &workerDB{db: db, observer: observer, clock: startpermit.NewClock()}
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
	var execution, taskID, nonce, armed, intent, cancelled, attaches string
	err := w.db.QueryRow(`SELECT value FROM meta WHERE key = 'execution_id'`).Scan(&execution)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	w.execution = execution
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'task_id'`).Scan(&taskID)
	w.task = taskID
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'start_nonce'`).Scan(&nonce)
	w.nonce = nonce
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'start_armed_mono'`).Scan(&armed)
	if armed != "" {
		fmt.Sscan(armed, &w.armedMono)
	}
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'start_intent'`).Scan(&intent)
	w.intent = intent == "1"
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'start_cancelled'`).Scan(&cancelled)
	w.cancelled = cancelled == "1"
	if w.nonce != "" && w.clock != nil {
		w.clock.Restore()
	}
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
	w.task = taskID
	return nil
}

// Arm 记录这次许可请求的 nonce 和单调时钟。重复调用不会把时钟拨回，也不会启动执行器。
func (w *workerDB) Arm(taskID, executionID string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.execution == "" || w.execution != executionID || (w.task != "" && w.task != taskID) {
		return "", errors.New("执行还没有绑定")
	}
	if w.nonce != "" && w.armedMono > 0 {
		return w.nonce, nil
	}
	nonce, err := identity.NewUUID()
	if err != nil {
		return "", err
	}
	mono, err := w.clock.Arm()
	if err != nil {
		return "", errors.New("无法读取单调时钟")
	}
	tx, err := w.db.Begin()
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "start_nonce", nonce); err != nil {
		return "", err
	}
	if err := putMeta(tx, "start_armed_mono", fmt.Sprintf("%d", int64(mono))); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	w.nonce = nonce
	w.armedMono = int64(mono)
	return nonce, nil
}

// Authorize 在 Session 互斥区内校验许可、排队期限和取消，先提交 start_intent，然后才调用测试执行器。
// 不提交任务输入，也不运行启动钩子。已经有 start_intent 时不会再次启动。
func (w *workerDB) Authorize(taskID, executionID, permit, publicKey, generation string, queueExpires time.Time) (started bool, refused bool, code string, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.intent {
		return true, false, "", nil
	}
	if w.execution == "" || w.execution != executionID || w.task != taskID {
		return false, true, "invalid_target", nil
	}
	if w.cancelled {
		return false, true, "cancelled", nil
	}
	raw, decErr := base64.RawURLEncoding.DecodeString(publicKey)
	if decErr != nil || len(raw) != ed25519.PublicKeySize {
		return false, true, "invalid_target", nil
	}
	claims, verErr := startpermit.Verify(ed25519.PublicKey(raw), permit)
	if verErr != nil || claims.ExecutionID != w.execution || claims.TaskID != w.task || claims.Nonce != w.nonce || claims.StorageGeneration != generation {
		return false, true, "invalid_target", nil
	}
	if queueExpires.IsZero() || !claims.QueueExpiresAt.Equal(queueExpires.UTC()) {
		return false, true, "invalid_target", nil
	}
	nowMono, monoErr := w.clock.Mono()
	if monoErr != nil || w.armedMono <= 0 {
		return false, true, "unavailable", nil
	}
	rtt := nowMono - time.Duration(w.armedMono)
	if _, ok := startpermit.Remaining(claims.ExpiresAt.Sub(claims.IssuedAt), rtt); !ok {
		return false, true, "queue_timeout", nil
	}
	tx, err := w.db.Begin()
	if err != nil {
		return false, false, "", err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "start_intent", "1"); err != nil {
		return false, false, "", err
	}
	if err := tx.Commit(); err != nil {
		return false, false, "", err
	}
	w.intent = true
	// 意图已经落盘。此后即使执行器失败，也不能再报告“尚未启动”。
	if w.observer != nil {
		_ = w.observer.Start(context.Background())
	}
	return true, false, "", nil
}

// CancelLocal 记录本地取消。start_intent 已经存在时保留它，不把执行改写成未启动。
func (w *workerDB) CancelLocal() (started bool, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.intent {
		return true, nil
	}
	tx, err := w.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "start_cancelled", "1"); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	w.cancelled = true
	return false, nil
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

func (w *workerDB) snapshot() (int, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.attaches, w.intent
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
