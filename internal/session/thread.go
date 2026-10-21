package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/startpermit"
)

// ThreadOptions 是账本中保存的 Thread 身份与适配器配置。
type ThreadOptions struct {
	ThreadID                string        `json:"thread_id"`
	StorageGeneration       string        `json:"storage_generation"`
	NodeID                  string        `json:"node_id"`
	AgentType               string        `json:"agent_type"`
	WorkingDirectory        string        `json:"working_directory"`
	ExecutionTimeoutSeconds int           `json:"execution_timeout_seconds"`
	AdapterConfig           agent.Config  `json:"adapter_config"`
	StopTimeout             time.Duration `json:"stop_timeout,omitempty"`
}

type ThreadAdapterFactory func(agentType string, config agent.Config) (agent.ThreadAdapter, error)

// ThreadProcessKiller 返回整个 Agent 进程树是否已确认回收。
// 适配器的 Close 不构成进程树回收证据。
type ThreadProcessKiller interface{ KillProcessTree() (bool, error) }

// ThreadWorker 独占一个 Thread 的消息队列、Turn 和上行报告。
// 调用方持有 Session 文件锁；所有方法可与轮询协程并发调用。
type ThreadWorker struct {
	mu        sync.Mutex
	db        *sql.DB
	dataDir   string
	options   ThreadOptions
	factory   ThreadAdapterFactory
	adapter   agent.ThreadAdapter
	clock     startpermit.Timer
	events    []agent.Event
	abortDone chan error
	forceKill func() (bool, error)
	closed    bool
	live      workerDB
}

func ThreadLedgerPath(dataDir, threadID string) (string, error) {
	dir, err := SessionDir(dataDir, threadID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "thread.db"), nil
}

const threadSchema = `
CREATE TABLE IF NOT EXISTS thread_meta (
 thread_id TEXT PRIMARY KEY, storage_generation TEXT NOT NULL, agent_type TEXT NOT NULL,
 working_directory TEXT NOT NULL, execution_timeout_seconds INTEGER NOT NULL,
 adapter_config TEXT NOT NULL, options_json TEXT NOT NULL, native_session_id TEXT NOT NULL DEFAULT '',
 current_turn_seq INTEGER NOT NULL DEFAULT 0, turn_started_monotonic_ns INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'opening', stop_requested_at INTEGER NOT NULL DEFAULT 0,
 stop_reason TEXT NOT NULL DEFAULT '', commit_token TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS thread_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, client_message_id TEXT NOT NULL UNIQUE,
 mode TEXT NOT NULL CHECK(mode IN ('queue','steer')), content TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','intent','sent','withdrawn','unknown')),
 turn_seq INTEGER NOT NULL DEFAULT 0, intent_user_count INTEGER NOT NULL DEFAULT -1);
CREATE TABLE IF NOT EXISTS thread_turns (
 turn_seq INTEGER PRIMARY KEY, client_message_id TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS thread_one_active_turn ON thread_turns((1)) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS thread_replies (
 reply_seq INTEGER PRIMARY KEY AUTOINCREMENT, turn_seq INTEGER NOT NULL REFERENCES thread_turns(turn_seq),
 content TEXT NOT NULL, truncated INTEGER NOT NULL, original_bytes INTEGER NOT NULL,
 attachments TEXT NOT NULL, metadata TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread_outbox (
 worker_seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
 report_json TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN (0,1)));
`

func openThreadDB(dataDir string, options ThreadOptions, create bool) (*sql.DB, ThreadOptions, error) {
	path, err := ThreadLedgerPath(dataDir, options.ThreadID)
	if err != nil {
		return nil, options, err
	}
	if !create {
		if _, err := os.Stat(path); err != nil {
			return nil, options, err
		}
	}
	if err := fileaccess.PrepareDataDir(filepath.Dir(path)); err != nil {
		return nil, options, err
	}
	db, err := sql.Open("sqlite", sqliteDSN(path)+"&_pragma=foreign_keys(ON)")
	if err != nil {
		return nil, options, err
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*sql.DB, ThreadOptions, error) { db.Close(); return nil, options, err }
	if _, err := db.Exec(threadSchema); err != nil {
		return fail(err)
	}
	if create {
		if options.StorageGeneration == "" || options.AgentType == "" || options.ExecutionTimeoutSeconds < 0 {
			return fail(errors.New("Thread 配置无效"))
		}
		config := &options.AdapterConfig
		config.DataDir, config.Directory, config.SessionID, config.ExecutionID = dataDir, options.WorkingDirectory, options.ThreadID, options.ThreadID
		config.SessionDir = filepath.Join(filepath.Dir(path), "native")
		config.StatePath = filepath.Join(config.SessionDir, "state.json")
	}
	if options.StopTimeout <= 0 {
		options.StopTimeout = time.Minute
	}
	if create {
		raw, err := json.Marshal(options)
		if err != nil {
			return fail(err)
		}
		config, err := json.Marshal(options.AdapterConfig)
		if err != nil {
			return fail(err)
		}
		if _, err := db.Exec(`INSERT INTO thread_meta(thread_id,storage_generation,agent_type,working_directory,execution_timeout_seconds,adapter_config,options_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO NOTHING`, options.ThreadID, options.StorageGeneration, options.AgentType, options.WorkingDirectory, options.ExecutionTimeoutSeconds, string(config), string(raw)); err != nil {
			return fail(err)
		}
	}
	var raw string
	if err := db.QueryRow(`SELECT options_json FROM thread_meta WHERE thread_id=?`, options.ThreadID).Scan(&raw); err != nil {
		return fail(err)
	}
	var saved ThreadOptions
	if err := json.Unmarshal([]byte(raw), &saved); err != nil {
		return fail(err)
	}
	if create && (saved.StorageGeneration != options.StorageGeneration || saved.AgentType != options.AgentType || saved.WorkingDirectory != options.WorkingDirectory || saved.NodeID != options.NodeID || saved.ExecutionTimeoutSeconds != options.ExecutionTimeoutSeconds) {
		return fail(errors.New("Thread 配置冲突"))
	}
	if err := chmodDB(path); err != nil {
		return fail(err)
	}
	return db, saved, nil
}

// OpenThreadWorker 打开已有账本或创建一个新 Thread，并恢复未确认的发送意图。
func OpenThreadWorker(ctx context.Context, dataDir string, options ThreadOptions, factory ThreadAdapterFactory) (*ThreadWorker, error) {
	db, saved, err := openThreadDB(dataDir, options, true)
	if err != nil {
		return nil, err
	}
	w := &ThreadWorker{db: db, dataDir: dataDir, options: saved, factory: factory, clock: startpermit.NewClock()}
	if err := w.open(ctx); err != nil {
		w.Close()
		return nil, err
	}
	return w, nil
}

// transaction 通过独立连接检查提交标识，消除 SQLite COMMIT 返回值不明的歧义。
func (w *ThreadWorker) transaction(fn func(*sql.Tx) error) error {
	token, err := identity.NewUUID()
	if err != nil {
		return err
	}
	conn, err := w.db.Conn(context.Background())
	if err != nil {
		return err
	}
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		conn.Close()
		return err
	}
	defer rollbackOutputTx(conn, tx)
	if err := fn(tx); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE thread_meta SET commit_token=?`, token); err != nil {
		return err
	}
	return commitOutputTx(conn, tx, func() (bool, error) {
		var saved string
		err := w.db.QueryRow(`SELECT commit_token FROM thread_meta`).Scan(&saved)
		return saved == token, err
	})
}

func (w *ThreadWorker) report(tx *sql.Tx, r protocol.ThreadReport) error {
	id, err := identity.NewUUID()
	if err != nil {
		return err
	}
	var seq int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(worker_seq),0)+1 FROM thread_outbox`).Scan(&seq); err != nil {
		return err
	}
	r.Type, r.ThreadID, r.EventID, r.WorkerSeq = protocol.BodyThreadReport, w.options.ThreadID, id, seq
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if len(raw) > 256<<10 {
		return errors.New("Thread 报告超过传输上限")
	}
	_, err = tx.Exec(`INSERT INTO thread_outbox(worker_seq,event_id,report_json) VALUES(?,?,?)`, seq, id, string(raw))
	return err
}

func (w *ThreadWorker) status() (string, error) {
	var status string
	err := w.db.QueryRow(`SELECT status FROM thread_meta`).Scan(&status)
	return status, err
}

func (w *ThreadWorker) active() (int64, error) {
	var turn int64
	err := w.db.QueryRow(`SELECT turn_seq FROM thread_turns WHERE ended_at IS NULL`).Scan(&turn)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return turn, err
}

func (w *ThreadWorker) stateReport(tx *sql.Tx, status, kind, reason string) error {
	if _, err := tx.Exec(`UPDATE thread_meta SET status=?,stop_requested_at=0,stop_reason=''`, status); err != nil {
		return err
	}
	return w.report(tx, protocol.ThreadReport{Kind: kind, Reason: reason})
}

func (w *ThreadWorker) startAdapter(ctx context.Context, restore bool) error {
	if err := fileaccess.ValidateThreadWorkingDirectory(w.dataDir, w.options.WorkingDirectory); err != nil {
		return err
	}
	if w.factory == nil {
		return errors.New("Thread 适配器未配置")
	}
	if w.adapter != nil {
		if err := w.adapter.Close(); err != nil {
			return err
		}
		w.adapter = nil
	}
	config := w.options.AdapterConfig
	config.Restore = restore
	a, err := w.factory(w.options.AgentType, config)
	if err != nil {
		return err
	}
	w.adapter = a
	if restore && !a.Capabilities().Resume && w.options.AgentType != "shell" {
		return agent.ErrHistoryMissing
	}
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := a.Start(startCtx); err != nil {
		_ = a.Close()
		w.adapter = nil
		return err
	}
	return nil
}

func (w *ThreadWorker) open(ctx context.Context) error {
	status, err := w.status()
	if err != nil {
		return err
	}
	if status == "opening" {
		if err := w.transaction(func(tx *sql.Tx) error { _, err := tx.Exec(`UPDATE thread_meta SET status='starting'`); return err }); err != nil {
			return err
		}
	}
	err = w.startAdapter(ctx, status != "opening")
	if err != nil {
		kind, state := "thread.stopped", "stopped"
		if status == "opening" || status == "starting" {
			kind = "thread.open_failed"
		}
		return w.transaction(func(tx *sql.Tx) error {
			if status != "opening" {
				if err := w.unknownIntentsTx(tx); err != nil {
					return err
				}
				if err := w.endTx(tx, agent.EndAgentExited); err != nil {
					return err
				}
			}
			return w.stateReport(tx, state, kind, err.Error())
		})
	}
	if status == "opening" || status == "starting" {
		native := ""
		if provider, ok := w.adapter.(agent.SessionIDProvider); ok {
			native = provider.NativeSessionID()
		}
		return w.transaction(func(tx *sql.Tx) error {
			if _, err := tx.Exec(`UPDATE thread_meta SET status='idle',native_session_id=?`, native); err != nil {
				return err
			}
			return w.report(tx, protocol.ThreadReport{Kind: "thread.opened", StorageGeneration: w.options.StorageGeneration, NativeSessionID: native})
		})
	}
	if err := w.recoverIntents(); err != nil {
		return err
	}
	// 完成记录和已落地的回复先进入账本，再处理无法确认的活动 Turn。
	if err := w.drainLocked(); err != nil {
		return err
	}
	turn, err := w.active()
	if err != nil {
		return err
	}
	if turn != 0 {
		if err := w.transaction(func(tx *sql.Tx) error {
			if err := w.endTx(tx, agent.EndAgentExited); err != nil {
				return err
			}
			return w.stateReport(tx, "unknown", "thread.unknown", "Worker 重启后无法确认原 Turn 状态")
		}); err != nil {
			return err
		}
	}
	state, err := w.status()
	if err != nil {
		return err
	}
	if state == "idle" {
		return w.sendNext(ctx)
	}
	return nil
}

func (w *ThreadWorker) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	var err error
	if w.adapter != nil {
		err = w.adapter.Close()
	}
	return errors.Join(err, w.db.Close())
}

func threadValidateMessage(id, content, mode string) error {
	if id == "" || len(id) > 1024 || content == "" || len(content) > 64<<10 || !utf8.ValidString(content) || (mode != "queue" && mode != "steer") {
		return errors.New("Thread 消息无效")
	}
	raw, err := json.Marshal(protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: "00000000-0000-4000-8000-000000000000", StorageGeneration: "00000000-0000-4000-8000-000000000000", Action: "message", ClientMessageID: id, Content: content, Mode: mode})
	if err != nil {
		return err
	}
	if len(raw)+4096 > 256<<10 {
		return errors.New("Thread 消息超过传输上限")
	}
	return nil
}

func (w *ThreadWorker) EnqueueThreadMessage(ctx context.Context, id, content, mode string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if mode == "" {
		mode = "queue"
	}
	if err := threadValidateMessage(id, content, mode); err != nil {
		return err
	}
	var oldContent, oldMode string
	err := w.db.QueryRow(`SELECT content,mode FROM thread_messages WHERE client_message_id=?`, id).Scan(&oldContent, &oldMode)
	if err == nil {
		if oldContent != content || oldMode != mode {
			return errors.New("client_message_id 内容冲突")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	turn, err := w.active()
	if err != nil {
		return err
	}
	if w.options.AgentType == "shell" {
		var count int
		if err := w.db.QueryRow(`SELECT COUNT(*) FROM thread_messages`).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("shell Thread 只接受一条消息")
		}
	}
	if turn != 0 && mode == "steer" && (w.adapter == nil || !w.adapter.Capabilities().Steer) {
		return agent.ErrUnsupported
	}
	var stopping int64
	if err := w.db.QueryRow(`SELECT stop_requested_at FROM thread_meta`).Scan(&stopping); err != nil {
		return err
	}
	if stopping != 0 {
		return errors.New("Thread 正在停止")
	}
	state, err := w.status()
	if err != nil {
		return err
	}
	if state == "stopped" || state == "unknown" {
		if err := w.startAdapter(ctx, true); err != nil {
			if saveErr := w.transaction(func(tx *sql.Tx) error { return w.stateReport(tx, "stopped", "thread.stopped", err.Error()) }); saveErr != nil {
				return saveErr
			}
			return err
		}
		if err := w.transaction(func(tx *sql.Tx) error {
			_, err := tx.Exec(`UPDATE thread_meta SET status='idle',stop_requested_at=0,stop_reason=''`)
			return err
		}); err != nil {
			return err
		}
	}
	if err := w.transaction(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO thread_messages(client_message_id,content,mode,status) VALUES(?,?,?,'queued')`, id, content, mode); err != nil {
			return err
		}
		return w.report(tx, protocol.ThreadReport{Kind: "message.queued", ClientMessageID: id})
	}); err != nil {
		return err
	}
	if turn != 0 && mode == "steer" {
		return w.send(ctx, id, content, turn, true)
	}
	if turn == 0 {
		return w.sendNext(ctx)
	}
	return nil
}

func (w *ThreadWorker) sendNext(ctx context.Context) error {
	state, err := w.status()
	if err != nil {
		return err
	}
	if state != "idle" {
		return nil
	}
	var id, text string
	err = w.db.QueryRow(`SELECT client_message_id,content FROM thread_messages WHERE status='queued' ORDER BY seq LIMIT 1`).Scan(&id, &text)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var turn int64
	if err := w.db.QueryRow(`SELECT current_turn_seq+1 FROM thread_meta`).Scan(&turn); err != nil {
		return err
	}
	return w.send(ctx, id, text, turn, false)
}

func (w *ThreadWorker) send(ctx context.Context, id, text string, turn int64, steer bool) error {
	if w.adapter == nil {
		return errors.New("Thread 适配器不可用")
	}
	count := -1
	if restorer, ok := w.adapter.(agent.IntentRestorer); ok {
		var err error
		count, err = restorer.UserMessageCount()
		if err != nil {
			return err
		}
	}
	if err := w.transaction(func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE thread_messages SET status='intent',turn_seq=?,intent_user_count=? WHERE client_message_id=? AND status='queued'`, turn, count, id)
		return err
	}); err != nil {
		return err
	}
	sendCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var err error
	if steer {
		err = w.adapter.Steer(sendCtx, id, text)
	} else {
		err = w.adapter.Send(sendCtx, id, text)
	}
	if err != nil {
		// intent 已经持久化；查询失败也不能重发。
		if recoveryErr := w.recoverIntents(); recoveryErr != nil {
			return recoveryErr
		}
		return err
	}
	return w.confirmSent(id, turn)
}

func (w *ThreadWorker) confirmSent(id string, turn int64) error {
	mono, err := w.clock.Mono()
	if err != nil {
		return err
	}
	return w.transaction(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE thread_messages SET status='sent' WHERE client_message_id=?`, id); err != nil {
			return err
		}
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM thread_turns WHERE turn_seq=?`, turn).Scan(&exists); err != nil {
			return err
		}
		// turn.started 先落地，中心才能用已存在的 Turn 关联 message.sent。
		if exists == 0 {
			if _, err := tx.Exec(`INSERT INTO thread_turns(turn_seq,client_message_id,started_at) VALUES(?,?,?)`, turn, id, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE thread_meta SET current_turn_seq=?,turn_started_monotonic_ns=?,status='running'`, turn, int64(mono)); err != nil {
				return err
			}
			if err := w.report(tx, protocol.ThreadReport{Kind: "turn.started", WorkerTurnSeq: turn, ClientMessageID: id}); err != nil {
				return err
			}
		}
		return w.report(tx, protocol.ThreadReport{Kind: "message.sent", WorkerTurnSeq: turn, ClientMessageID: id})
	})
}

func (w *ThreadWorker) unknownIntentsTx(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT client_message_id FROM thread_messages WHERE status='intent' ORDER BY seq`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.Exec(`UPDATE thread_messages SET status='unknown' WHERE client_message_id=?`, id); err != nil {
			return err
		}
		if err := w.report(tx, protocol.ThreadReport{Kind: "message.unknown", ClientMessageID: id}); err != nil {
			return err
		}
	}
	return nil
}

func (w *ThreadWorker) recoverIntents() error {
	rows, err := w.db.Query(`SELECT client_message_id,content,turn_seq,intent_user_count FROM thread_messages WHERE status='intent' ORDER BY seq`)
	if err != nil {
		return err
	}
	type intent struct {
		id, text string
		turn     int64
		count    int
	}
	var intents []intent
	for rows.Next() {
		var in intent
		if err := rows.Scan(&in.id, &in.text, &in.turn, &in.count); err != nil {
			rows.Close()
			return err
		}
		intents = append(intents, in)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, in := range intents {
		if restorer, ok := w.adapter.(agent.IntentRestorer); ok {
			restorer.RestoreIntent(in.id, in.text, in.count)
		}
		sent, err := w.adapter.Sent(in.id)
		if err == nil && sent {
			if err := w.confirmSent(in.id, in.turn); err != nil {
				return err
			}
			continue
		}
		return w.transaction(func(tx *sql.Tx) error {
			if err := w.unknownIntentsTx(tx); err != nil {
				return err
			}
			if err := w.endTx(tx, agent.EndAgentExited); err != nil {
				return err
			}
			return w.stateReport(tx, "unknown", "thread.unknown", "无法确认消息是否已经发出")
		})
	}
	return nil
}

func (w *ThreadWorker) WithdrawThreadMessage(id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.transaction(func(tx *sql.Tx) error {
		var status string
		if err := tx.QueryRow(`SELECT status FROM thread_messages WHERE client_message_id=?`, id).Scan(&status); err != nil {
			return err
		}
		if status == "withdrawn" {
			return nil
		}
		if status != "queued" {
			return errors.New("消息已提交发送意图，无法撤回")
		}
		if _, err := tx.Exec(`UPDATE thread_messages SET status='withdrawn' WHERE client_message_id=?`, id); err != nil {
			return err
		}
		return w.report(tx, protocol.ThreadReport{Kind: "message.withdrawn", ClientMessageID: id})
	})
}

func (w *ThreadWorker) endTx(tx *sql.Tx, reason string) error {
	var turn int64
	err := tx.QueryRow(`SELECT turn_seq FROM thread_turns WHERE ended_at IS NULL`).Scan(&turn)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE thread_turns SET ended_at=?,end_reason=? WHERE turn_seq=?`, time.Now().UTC().Format(time.RFC3339Nano), reason, turn); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM thread_messages WHERE status='queued'`).Scan(&count); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE thread_meta SET status='idle',stop_requested_at=0,stop_reason=''`); err != nil {
		return err
	}
	return w.report(tx, protocol.ThreadReport{Kind: "turn.ended", WorkerTurnSeq: turn, Reason: reason, QueueEmpty: count == 0})
}

func truncateThreadReply(text string) (string, bool, int64) {
	original := int64(len(text))
	if len(text) <= 32<<10 {
		return text, false, original
	}
	head, tail := 16<<10, len(text)-(16<<10)
	for head > 0 && !utf8.RuneStart(text[head]) {
		head--
	}
	for tail < len(text) && !utf8.RuneStart(text[tail]) {
		tail++
	}
	return text[:head] + text[tail:], true, original
}

func (w *ThreadWorker) saveEvent(event agent.Event) error {
	turn, err := w.active()
	if err != nil {
		return err
	}
	switch event.Kind {
	case agent.EventTurnStarted:
		return nil
	case agent.EventReply:
		if turn == 0 {
			return errors.New("没有活动 Turn 的回复")
		}
		content, truncated, original := truncateThreadReply(event.Content)
		if event.Truncated {
			truncated = true
		}
		if event.OriginalBytes > original {
			original = event.OriginalBytes
		}
		// 配置读取失败时保留事件，下次轮询重试，回复不会脱离其附件事务。
		attachments, err := fileaccess.ParseThreadAttachments(w.dataDir, w.options.NodeID, w.options.WorkingDirectory, event.Content)
		if err != nil {
			return err
		}
		refs, err := json.Marshal(attachments)
		if err != nil {
			return err
		}
		metadata := event.Metadata
		if len(metadata) == 0 {
			metadata = json.RawMessage(`{}`)
		}
		if !json.Valid(metadata) {
			return errors.New("回复元数据无效")
		}
		return w.transaction(func(tx *sql.Tx) error {
			if _, err := tx.Exec(`INSERT INTO thread_replies(turn_seq,content,truncated,original_bytes,attachments,metadata) VALUES(?,?,?,?,?,?)`, turn, content, truncated, original, string(refs), string(metadata)); err != nil {
				return err
			}
			return w.report(tx, protocol.ThreadReport{Kind: "reply", WorkerTurnSeq: turn, Content: content, Truncated: truncated, OriginalBytes: original, Attachments: refs, Metadata: metadata})
		})
	case agent.EventTurnEnded:
		if turn == 0 {
			return nil
		}
		reason := event.Reason
		if reason == "" {
			reason = agent.EndCompleted
		}
		var stopReason string
		if err := w.db.QueryRow(`SELECT stop_reason FROM thread_meta`).Scan(&stopReason); err != nil {
			return err
		}
		if stopReason != "" {
			reason = stopReason
		}
		return w.transaction(func(tx *sql.Tx) error {
			if err := w.endTx(tx, reason); err != nil {
				return err
			}
			if w.options.AgentType == "shell" {
				return w.stateReport(tx, "stopped", "thread.stopped", "命令已结束")
			}
			return nil
		})
	case agent.EventExited, agent.EventUncertain:
		reason := agent.EndAgentExited
		var stopReason string
		if err := w.db.QueryRow(`SELECT stop_reason FROM thread_meta`).Scan(&stopReason); err != nil {
			return err
		}
		if stopReason != "" {
			reason = stopReason
		}
		state, kind := "stopped", "thread.stopped"
		if event.Kind == agent.EventUncertain {
			state, kind = "unknown", "thread.unknown"
		}
		return w.transaction(func(tx *sql.Tx) error {
			if err := w.endTx(tx, reason); err != nil {
				return err
			}
			return w.stateReport(tx, state, kind, event.Reason)
		})
	}
	return nil
}

func (w *ThreadWorker) drainLocked() error {
	if w.adapter == nil {
		return nil
	}
	if live, ok := w.adapter.(agent.LiveAdapter); ok {
		text, gap := live.DrainLive()
		w.live.appendLiveLocked(text, gap)
	}
	if len(w.events) == 0 {
		w.events = w.adapter.DrainEvents()
	}
	for len(w.events) > 0 {
		if err := w.saveEvent(w.events[0]); err != nil {
			return err
		}
		w.events = w.events[1:]
	}
	return nil
}

// Poll 持续读取输出、保存报告并推进队列和执行时限。
func (w *ThreadWorker) Poll(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errors.New("Thread Worker 已关闭")
	}
	if err := w.recoverIntents(); err != nil {
		return err
	}
	if err := w.drainLocked(); err != nil {
		return err
	}
	var stopAt, started int64
	var reason string
	if err := w.db.QueryRow(`SELECT stop_requested_at,stop_reason,turn_started_monotonic_ns FROM thread_meta`).Scan(&stopAt, &reason, &started); err != nil {
		return err
	}
	turn, err := w.active()
	if err != nil {
		return err
	}
	now, err := w.clock.Mono()
	if err != nil {
		if turn != 0 {
			return w.forceStopLocked(agent.EndTimeout)
		}
		return err
	}
	if stopAt != 0 {
		failed := false
		if w.abortDone != nil {
			select {
			case err := <-w.abortDone:
				failed = err != nil
				w.abortDone = nil
			default:
			}
		}
		if failed || now-time.Duration(stopAt-1) >= w.options.StopTimeout {
			return w.forceStopLocked(reason)
		}
		return nil
	}
	if turn != 0 && w.options.ExecutionTimeoutSeconds > 0 && now-time.Duration(started) >= time.Duration(w.options.ExecutionTimeoutSeconds)*time.Second {
		return w.stopLocked(agent.EndTimeout)
	}
	if turn == 0 {
		w.abortDone = nil
		return w.sendNext(ctx)
	}
	return nil
}

func (w *ThreadWorker) StopThread(reason string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stopLocked(reason)
}

func (w *ThreadWorker) stopLocked(reason string) error {
	if reason == "" {
		reason = agent.EndStopped
	}
	if reason != agent.EndStopped && reason != agent.EndTimeout {
		return errors.New("停止原因无效")
	}
	now, err := w.clock.Mono()
	if err != nil {
		return err
	}
	// 0 表示没有停止请求；存储值加一以保留单调时钟的零起点。
	now++
	if err := w.transaction(func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT client_message_id FROM thread_messages WHERE status='queued' ORDER BY seq`)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE thread_messages SET status='withdrawn' WHERE status='queued'`); err != nil {
			return err
		}
		for _, id := range ids {
			if err := w.report(tx, protocol.ThreadReport{Kind: "message.withdrawn", ClientMessageID: id}); err != nil {
				return err
			}
		}
		_, err = tx.Exec(`UPDATE thread_meta SET stop_requested_at=?,stop_reason=? WHERE stop_requested_at=0`, int64(now), reason)
		return err
	}); err != nil {
		return err
	}
	turn, err := w.active()
	if err != nil {
		return err
	}
	state, err := w.status()
	if err != nil {
		return err
	}
	if turn == 0 && state != "unknown" {
		return w.transaction(func(tx *sql.Tx) error {
			_, err := tx.Exec(`UPDATE thread_meta SET stop_requested_at=0,stop_reason=''`)
			return err
		})
	}
	if w.adapter == nil {
		return w.forceStopLocked(reason)
	}
	if w.abortDone == nil {
		done := make(chan error, 1)
		w.abortDone = done
		adapter := w.adapter
		go func() { _, _, err := adapter.Abort(); done <- err }()
	}
	return nil
}

func (w *ThreadWorker) forceStopLocked(reason string) error {
	confirmed := false
	if killer, ok := w.adapter.(ThreadProcessKiller); ok {
		known, err := killer.KillProcessTree()
		confirmed = known && err == nil
	} else if w.forceKill != nil {
		known, err := w.forceKill()
		confirmed = known && err == nil
	}
	if w.adapter != nil {
		_ = w.adapter.Close()
	}
	w.abortDone = nil
	if err := w.drainLocked(); err != nil {
		return err
	}
	return w.transaction(func(tx *sql.Tx) error {
		if err := w.endTx(tx, reason); err != nil {
			return err
		}
		state, kind, message := "stopped", "thread.stopped", "Agent 没有在 1 分钟内停下，已结束进程"
		if !confirmed {
			state, kind, message = "unknown", "thread.unknown", "无法确认 Agent 进程树已经回收"
		}
		return w.stateReport(tx, state, kind, message)
	})
}

func (w *ThreadWorker) ThreadPending(afterWorkerSeq int64) ([]protocol.ThreadReport, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	rows, err := w.db.Query(`SELECT report_json FROM thread_outbox WHERE acked=0 AND worker_seq>? ORDER BY worker_seq LIMIT 100`, afterWorkerSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reports := []protocol.ThreadReport{}
	size := 0
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if size+len(raw) > 192<<10 && len(reports) > 0 {
			break
		}
		var report protocol.ThreadReport
		if err := json.Unmarshal([]byte(raw), &report); err != nil {
			return nil, err
		}
		reports = append(reports, report)
		size += len(raw)
	}
	return reports, rows.Err()
}

func (w *ThreadWorker) ThreadAck(eventID string, workerSeq int64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if workerSeq < 0 || (eventID == "" && workerSeq == 0) {
		return errors.New("确认标识无效")
	}
	result, err := w.db.Exec(`UPDATE thread_outbox SET acked=1 WHERE (?='' OR event_id=?) AND (?=0 OR worker_seq=?)`, eventID, eventID, workerSeq, workerSeq)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n != 1 {
		return fmt.Errorf("Thread 报告确认不匹配")
	}
	return err
}
