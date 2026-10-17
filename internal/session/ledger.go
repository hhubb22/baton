package session

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"

	"modernc.org/sqlite"
)

var (
	// ErrHistoryMissing 表示已知 Session 的账本文件不存在。调用方不能新建空账本假装恢复成功。
	ErrHistoryMissing = errors.New("Session 历史缺失")
	// ErrHistoryIncompatible 表示账本已损坏或不是本组件能读取的格式。
	ErrHistoryIncompatible = errors.New("Session 历史已损坏或不兼容")
	// ErrHistoryUnread 表示这次没有读成账本。它不是损坏证据，调用方应在下次心跳重试。
	ErrHistoryUnread = errors.New("Session 历史这次没有读成")
)

type workerDB struct {
	db                 *sql.DB
	mu                 sync.Mutex
	execution          string
	task               string
	nonce              string
	armedMono          int64
	intent             bool
	cancelled          bool
	inputSubmitted     bool
	inputResolved      bool
	resultDelivered    bool
	recoveredUncertain bool
	uncertainCode      string
	generation         int
	attaches           int
	observer           *Observer
	clock              *startpermit.Clock
}

func openWorkerDB(path string, observer *Observer) (*workerDB, error) {
	info, statErr := os.Stat(path)
	fresh := errors.Is(statErr, os.ErrNotExist)
	if fresh {
		return nil, ErrHistoryMissing
	}
	if statErr != nil {
		return nil, ErrHistoryIncompatible
	}
	if info.IsDir() || info.Size() == 0 {
		return nil, ErrHistoryIncompatible
	}
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, ErrHistoryIncompatible
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, ErrHistoryIncompatible
	}
	if err := verifyWorkerSchema(db); err != nil {
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
	var submitted, resolved, delivered, generation string
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'input_submitted'`).Scan(&submitted)
	w.inputSubmitted = submitted == "1"
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'input_resolved'`).Scan(&resolved)
	w.inputResolved = resolved == "1"
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'result_delivered'`).Scan(&delivered)
	w.resultDelivered = delivered == "1"
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'input_generation'`).Scan(&generation)
	if generation != "" {
		fmt.Sscan(generation, &w.generation)
	}
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
	if w.hasResultLocked() {
		w.inputResolved = true
	} else if w.intent && !w.inputResolved {
		w.recoveredUncertain = true
		w.uncertainCode = task.CodeUncertainInput
	} else if w.inputResolved {
		w.recoveredUncertain = true
		w.uncertainCode = task.CodeUncertainWorker
	}
	return nil
}

func (w *workerDB) hasResultLocked() bool {
	var n int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, protocol.ReportResult).Scan(&n); err != nil {
		return false
	}
	return n > 0
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
// 这里只进入启动，不提交任务输入，也不运行启动钩子。已经有 start_intent 时不会再次启动。
func (w *workerDB) Authorize(taskID, executionID, permit, publicKey, generation string, queueExpires time.Time) (started bool, refused bool, code string, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.intent {
		return true, false, "", nil
	}
	if w.execution == "" || w.execution != executionID || w.task != taskID {
		return w.refuse("invalid_target")
	}
	if w.cancelled {
		return w.refuse("cancelled")
	}
	raw, decErr := base64.RawURLEncoding.DecodeString(publicKey)
	if decErr != nil || len(raw) != ed25519.PublicKeySize {
		return w.refuse("invalid_target")
	}
	claims, verErr := startpermit.Verify(ed25519.PublicKey(raw), permit)
	if verErr != nil || claims.ExecutionID != w.execution || claims.TaskID != w.task || claims.Nonce != w.nonce || claims.StorageGeneration != generation {
		return w.refuse("invalid_target")
	}
	if queueExpires.IsZero() || !claims.QueueExpiresAt.Equal(queueExpires.UTC()) {
		return w.refuse("invalid_target")
	}
	nowMono, monoErr := w.clock.Mono()
	if monoErr != nil || w.armedMono <= 0 {
		return false, true, "unavailable", nil
	}
	rtt := nowMono - time.Duration(w.armedMono)
	if _, ok := startpermit.Remaining(claims.ExpiresAt.Sub(claims.IssuedAt), rtt); !ok {
		return w.refuse("queue_timeout")
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
	CrashAfter("start_intent")
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

// refuse 记下启动前的拒绝。这样的 Session 没有 start_intent，重启时不再拉起 Worker。
func (w *workerDB) refuse(code string) (bool, bool, string, error) {
	tx, err := w.db.Begin()
	if err != nil {
		return false, false, "", err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "start_refused", code); err != nil {
		return false, false, "", err
	}
	if err := tx.Commit(); err != nil {
		return false, false, "", err
	}
	return false, true, code, nil
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

type workerSnap struct {
	attaches        int
	intent          bool
	inputs          int64
	inputSubmitted  bool
	resultDelivered bool
	uncertain       bool
	taskID          string
	executionID     string
}

func (w *workerDB) snapshot() workerSnap {
	w.mu.Lock()
	defer w.mu.Unlock()
	var inputs int64
	if w.observer != nil {
		inputs = w.observer.Inputs()
	}
	return workerSnap{
		attaches: w.attaches, intent: w.intent, inputs: inputs,
		inputSubmitted: w.inputSubmitted, resultDelivered: w.resultDelivered,
		uncertain: w.recoveredUncertain, taskID: w.task, executionID: w.execution,
	}
}

// SubmitInput 在 start_intent 已经同步之后，只向执行器提交一次任务输入。
// 重复调用返回尚未确认的报告，不会再次调用执行器。
func (w *workerDB) SubmitInput(sessionID, payload string) ([]ipcReport, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.intent || w.execution == "" || w.task == "" {
		return nil, errors.New("还没有启动意图")
	}
	if w.recoveredUncertain || (w.inputSubmitted && !w.inputResolved) {
		return w.ensureVerificationLocked(sessionID)
	}
	if w.inputSubmitted || w.inputResolved {
		return w.pendingLocked()
	}
	if payload == "" || w.observer == nil {
		return nil, errors.New("任务输入无效")
	}
	if len(payload) > task.ExecutorInputLimit {
		return w.failOversizedLocked(sessionID)
	}
	tx, err := w.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "input_submitted", "1"); err != nil {
		return nil, err
	}
	if err := putMeta(tx, "input_generation", "1"); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	w.inputSubmitted = true
	w.generation = 1
	CrashAfter("input_intent")
	out, err := w.observer.SubmitInput(context.Background(), payload)
	if err != nil {
		w.recoveredUncertain = true
		w.uncertainCode = task.CodeUncertainInput
		return w.ensureVerificationLocked(sessionID)
	}
	CrashAfter("input_send")
	reports, err := w.recordExecution(sessionID, payload, out)
	if err != nil {
		return nil, err
	}
	CrashAfter("result_save")
	return reports, nil
}

// failOversizedLocked 不把超限输入交给执行器，而是记下失败并留下可回报的结果。
func (w *workerDB) failOversizedLocked(sessionID string) ([]ipcReport, error) {
	candidate := task.Candidate{
		Status:               task.StatusFailed,
		Summary:              "任务输入超过单条消息上限，没有提交给执行器",
		EvidenceEmptyReason:  "输入没有提交，没有证据",
		ArtifactsEmptyReason: "输入没有提交，没有产物",
		ErrorCode:            task.CodeExecutionFailed,
		ErrorMessage:         "任务输入超过单条消息上限",
	}
	if err := task.ValidateCandidate(candidate); err != nil {
		return nil, err
	}
	tx, err := w.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "input_submitted", "1"); err != nil {
		return nil, err
	}
	if err := putMeta(tx, "input_resolved", "1"); err != nil {
		return nil, err
	}
	if err := putMeta(tx, "input_generation", "1"); err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := insertLog(tx, "input", "任务输入超过单条消息上限", now); err != nil {
		return nil, err
	}
	resultID, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(reportFromCandidate(resultID, w.task, w.execution, sessionID, 1, candidate, true))
	if err != nil {
		return nil, err
	}
	if err := insertOutbox(tx, resultID, protocol.ReportResult, body); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	w.inputSubmitted = true
	w.inputResolved = true
	w.generation = 1
	return w.pendingLocked()
}

func (w *workerDB) recordExecution(sessionID, payload string, out Output) ([]ipcReport, error) {
	tx, err := w.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := insertLog(tx, "input", payload, now); err != nil {
		return nil, err
	}
	for _, line := range out.Progress {
		if err := insertLog(tx, "progress", line, now); err != nil {
			return nil, err
		}
	}
	startedID, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	started, err := json.Marshal(protocol.ExecutionReport{
		Type: protocol.BodyExecutionReport, EventID: startedID, TaskID: w.task, ExecutionID: w.execution,
		SessionID: sessionID, Kind: protocol.ReportStarted, InputGeneration: w.generation, Status: task.StatusRunning,
	})
	if err != nil {
		return nil, err
	}
	if err := insertOutbox(tx, startedID, protocol.ReportStarted, started); err != nil {
		return nil, err
	}
	if out.Final != "" {
		if err := insertLog(tx, "output", out.Final, now); err != nil {
			return nil, err
		}
	}
	if out.Exited || out.Uncertain || out.Final != "" {
		candidate := terminalCandidate(out)
		if candidate.Status == task.StatusCompleted && !out.Exited {
			candidate = task.Candidate{}
		}
		if candidate.Status != "" {
			resultID, err := identity.NewUUID()
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(reportFromCandidate(resultID, w.task, w.execution, sessionID, w.generation, candidate, out.Exited || out.Uncertain))
			if err != nil {
				return nil, err
			}
			if err := insertOutbox(tx, resultID, protocol.ReportResult, body); err != nil {
				return nil, err
			}
		}
	}
	if err := putMeta(tx, "input_resolved", "1"); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	w.inputResolved = true
	return w.pendingLocked()
}

func terminalCandidate(out Output) task.Candidate {
	if out.Uncertain {
		return task.FormatFailure(true)
	}
	if !out.Exited && out.Final == "" {
		return task.Candidate{}
	}
	parsed, err := task.ParseCandidate(out.Final)
	if err != nil || (parsed.Status == task.StatusCompleted && !out.Exited) {
		if out.Exited || out.Final != "" {
			return task.FormatFailure(false)
		}
		return task.Candidate{}
	}
	return parsed
}

func reportFromCandidate(eventID, taskID, executionID, sessionID string, generation int, candidate task.Candidate, stopped bool) protocol.ExecutionReport {
	return protocol.ExecutionReport{
		Type: protocol.BodyExecutionReport, EventID: eventID, TaskID: taskID, ExecutionID: executionID,
		SessionID: sessionID, Kind: protocol.ReportResult, InputGeneration: generation, Status: candidate.Status,
		Summary: candidate.Summary, Evidence: candidate.Evidence, Artifacts: candidate.Artifacts,
		EvidenceEmptyReason: candidate.EvidenceEmptyReason, ArtifactsEmptyReason: candidate.ArtifactsEmptyReason,
		ErrorCode: candidate.ErrorCode, ErrorMessage: candidate.ErrorMessage, AgentStopped: stopped,
	}
}

func (w *workerDB) Pending() ([]ipcReport, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pendingLocked()
}

func (w *workerDB) pendingLocked() ([]ipcReport, error) {
	rows, err := w.db.Query(`SELECT event_id, kind, payload FROM outbox WHERE delivered = 0 ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ipcReport
	for rows.Next() {
		var item ipcReport
		var payload string
		if err := rows.Scan(&item.EventID, &item.Kind, &payload); err != nil {
			return nil, err
		}
		item.Body = json.RawMessage(payload)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Ack 只在调用方已经拿到中心持久化确认之后标记本地交付。
func (w *workerDB) Ack(eventID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	var kind string
	var delivered int
	err := w.db.QueryRow(`SELECT kind, delivered FROM outbox WHERE event_id = ?`, eventID).Scan(&kind, &delivered)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("没有这条待确认记录")
	}
	if err != nil {
		return err
	}
	if delivered == 1 {
		if kind == protocol.ReportResult {
			w.resultDelivered = true
		}
		return nil
	}
	tx, err := w.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`UPDATE outbox SET delivered = 1 WHERE event_id = ?`, eventID); err != nil {
		return err
	}
	if kind == protocol.ReportResult {
		if err := putMeta(tx, "result_delivered", "1"); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if kind == protocol.ReportResult {
		w.resultDelivered = true
	}
	return nil
}

func insertLog(tx *sql.Tx, kind, body, now string) error {
	_, err := tx.Exec(`INSERT INTO execution_log (kind, body, created_at) VALUES (?, ?, ?)`, kind, body, now)
	return err
}

func insertOutbox(tx *sql.Tx, eventID, kind string, payload []byte) error {
	_, err := tx.Exec(`INSERT INTO outbox (event_id, kind, payload, delivered) VALUES (?, ?, ?, 0)`, eventID, kind, string(payload))
	return err
}

func (w *workerDB) recover(sessionID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.recoveredUncertain {
		return nil
	}
	_, err := w.ensureVerificationLocked(sessionID)
	return err
}

func (w *workerDB) ensureVerificationLocked(sessionID string) ([]ipcReport, error) {
	if w.execution == "" || w.task == "" {
		return nil, errors.New("还没有启动意图")
	}
	if w.uncertainCode == "" {
		w.uncertainCode = task.CodeUncertainInput
	}
	w.recoveredUncertain = true
	eventID, err := VerificationEventID(w.execution, w.uncertainCode)
	if err != nil {
		return nil, err
	}
	var existing int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE event_id = ?`, eventID).Scan(&existing); err != nil {
		return nil, err
	}
	if existing == 0 {
		body, err := json.Marshal(protocol.ExecutionReport{
			Type: protocol.BodyExecutionReport, EventID: eventID, TaskID: w.task, ExecutionID: w.execution,
			SessionID: sessionID, Kind: protocol.ReportNeedsVerification, Status: task.StatusNeedsVerification,
			ErrorCode: w.uncertainCode,
		})
		if err != nil {
			return nil, err
		}
		tx, err := w.db.Begin()
		if err != nil {
			return nil, err
		}
		defer func() { _ = tx.Rollback() }()
		if err := insertOutbox(tx, eventID, protocol.ReportNeedsVerification, body); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
	}
	return w.pendingLocked()
}

func putMeta(tx *sql.Tx, key, value string) error {
	_, err := tx.Exec(`INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func createWorkerSchema(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE writes (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			note TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE execution_log (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE outbox (
			event_id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			payload TEXT NOT NULL,
			delivered INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO meta (key, value) VALUES ('ledger_schema', '1');
	`); err != nil {
		return ErrHistoryIncompatible
	}
	return nil
}

func verifyWorkerSchema(db *sql.DB) error {
	var metaCount, outboxCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).Scan(&metaCount); err != nil {
		return classifyLedgerErr(err)
	}
	if metaCount != 1 {
		return ErrHistoryIncompatible
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'outbox'`).Scan(&outboxCount); err != nil {
		return classifyLedgerErr(err)
	}
	if outboxCount != 1 {
		return ErrHistoryIncompatible
	}
	var schema string
	err := db.QueryRow(`SELECT value FROM meta WHERE key = 'ledger_schema'`).Scan(&schema)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := db.Exec(`INSERT INTO meta (key, value) VALUES ('ledger_schema', '1')`); err != nil {
			return classifyLedgerErr(err)
		}
		return nil
	}
	if err != nil {
		return classifyLedgerErr(err)
	}
	if schema != "1" {
		return ErrHistoryIncompatible
	}
	return nil
}

// InspectLedger 只检查已有账本能不能读。文件不存在或内容不对时不会创建新文件。
func InspectLedger(path string) error {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return ErrHistoryMissing
	}
	if err != nil || info.IsDir() || info.Size() == 0 {
		return ErrHistoryIncompatible
	}
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return ErrHistoryIncompatible
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		return classifyLedgerErr(err)
	}
	return verifyWorkerSchema(db)
}

// CreateLedger 只在首次准备 Session 时新建账本。文件已经存在时不会覆盖。
func CreateLedger(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return ErrHistoryIncompatible
	}
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrHistoryIncompatible
	}
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return ErrHistoryIncompatible
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		return ErrHistoryIncompatible
	}
	if err := createWorkerSchema(db); err != nil {
		return err
	}
	return chmodDB(path)
}

// LedgerNeedsWorker 判断这个账本是否还要有一个常驻 Worker。已经交付或已经上报待核实的 Session 不再拉起。
func LedgerNeedsWorker(path string) (bool, error) {
	if err := InspectLedger(path); err != nil {
		return false, err
	}
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return false, classifyLedgerErr(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var pending, verification int
	if err := db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE delivered = 0`).Scan(&pending); err != nil {
		return false, classifyLedgerErr(err)
	}
	if pending > 0 {
		return true, nil
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, protocol.ReportNeedsVerification).Scan(&verification); err != nil {
		return false, classifyLedgerErr(err)
	}
	meta := map[string]string{}
	rows, err := db.Query(`SELECT key, value FROM meta`)
	if err != nil {
		return false, classifyLedgerErr(err)
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return false, classifyLedgerErr(err)
		}
		meta[key] = value
	}
	if err := rows.Err(); err != nil {
		return false, classifyLedgerErr(err)
	}
	if meta["result_delivered"] == "1" || verification > 0 {
		return false, nil
	}
	if meta["start_intent"] != "1" && (meta["start_cancelled"] == "1" || meta["start_refused"] != "") {
		return false, nil
	}
	return true, nil
}

// classifyLedgerErr 只把文件损坏当成不兼容。锁、忙和暂时打不开留到下次心跳。
func classifyLedgerErr(err error) error {
	if err == nil {
		return nil
	}
	var sqErr *sqlite.Error
	if errors.As(err, &sqErr) {
		switch sqErr.Code() & 0xff {
		case 11, 26: // SQLITE_CORRUPT, SQLITE_NOTADB
			return ErrHistoryIncompatible
		default:
			return ErrHistoryUnread
		}
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "not a database") || strings.Contains(text, "malformed") {
		return ErrHistoryIncompatible
	}
	return ErrHistoryUnread
}

// VerificationEventID 是同一次执行、同一个原因的待核实报告标识。不同原因不会互相覆盖。
func VerificationEventID(executionID, reason string) (string, error) {
	id, err := identity.ParseUUID(executionID)
	if err != nil {
		return "", err
	}
	if _, ok := task.UncertainMessage(reason); !ok {
		return "", errors.New("待核实原因无效")
	}
	sum := sha256.Sum256([]byte("baton-needs-verification-v1:" + reason + ":" + id))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// CrashAfter 在故障注入点结束当前进程。只有测试环境变量匹配时才生效。
func CrashAfter(point string) {
	if strings.TrimSpace(os.Getenv("BATON_TEST_CRASH_AFTER")) != point {
		return
	}
	if path := strings.TrimSpace(os.Getenv("BATON_TEST_CRASH_FILE")); path != "" {
		_ = os.WriteFile(path, []byte(point+"\n"), 0o600)
	}
	os.Exit(75)
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
