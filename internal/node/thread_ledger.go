package node

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

const DefaultThreadBudgetBytes int64 = 1 << 30

var ErrThreadBudget = errors.New("设备账本及待补报数据已达到空间水位")

// ThreadHost 在返回成功前持久化操作，以 commandID 去重；OpenThread 以 ThreadID 去重。
// ThreadPending 返回从 fromSeq 开始的未确认报告，每批至多 32 条。
// 报告序号、EventID 和正文在确认前保持不变，ThreadAck 必须同时匹配事件和序号。
// 实现应支持并发调用，且所有方法遵守 ctx 的期限。
type ThreadHost interface {
	OpenThread(ctx context.Context, thread ThreadRecord) error
	ThreadMessage(ctx context.Context, commandID string, cmd protocol.ThreadCommand) error
	ThreadWithdraw(ctx context.Context, commandID string, cmd protocol.ThreadCommand) error
	ThreadStop(ctx context.Context, commandID string, cmd protocol.ThreadCommand) error
	ThreadPending(ctx context.Context, threadID string, fromSeq int64) ([]protocol.ThreadReport, error)
	ThreadAck(ctx context.Context, threadID, eventID string, workerSeq int64) error
	// ThreadFailure 以 commandID 去重，并把失败写入 Worker 自己的报告序列。
	ThreadFailure(ctx context.Context, commandID, threadID, kind, reason string) error
}

type ThreadRecord struct {
	ThreadID                string
	SessionID               string
	StorageGeneration       string
	AgentType               string
	WorkingDirectory        string
	ExecutionTimeoutSeconds int
	OpenMessageID           string
	Status                  string
	CreatedAt               string
	UpdatedAt               string
}

const threadSchema = `
CREATE TABLE IF NOT EXISTS threads (
 thread_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL UNIQUE,
 storage_generation TEXT NOT NULL,
 agent_type TEXT NOT NULL,
 working_directory TEXT NOT NULL,
 execution_timeout_seconds INTEGER NOT NULL,
 open_message_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_command_receipts (
 message_id TEXT PRIMARY KEY,
 request_hash TEXT NOT NULL,
 result BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_node_reports (
 thread_id TEXT NOT NULL,
 event_id TEXT NOT NULL UNIQUE,
 worker_seq INTEGER NOT NULL,
 command_id TEXT NOT NULL UNIQUE,
 report BLOB NOT NULL,
 acked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(thread_id, worker_seq)
);
CREATE TABLE IF NOT EXISTS thread_report_progress (
 thread_id TEXT PRIMARY KEY,
 worker_seq INTEGER NOT NULL
);
`

func (l *Ledger) Thread(ctx context.Context, id string) (ThreadRecord, error) {
	var r ThreadRecord
	err := l.db.QueryRowContext(ctx, `SELECT thread_id, session_id, storage_generation, agent_type,
 working_directory, execution_timeout_seconds, open_message_id, status, created_at, updated_at
 FROM threads WHERE thread_id=?`, id).Scan(&r.ThreadID, &r.SessionID, &r.StorageGeneration, &r.AgentType,
		&r.WorkingDirectory, &r.ExecutionTimeoutSeconds, &r.OpenMessageID, &r.Status, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func (l *Ledger) threadIDs(ctx context.Context) ([]string, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT thread_id FROM threads UNION SELECT thread_id FROM thread_node_reports WHERE acked=0 ORDER BY thread_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CheckThreadBudget 统计数据目录中的普通文件，包含 SQLite WAL 与 Worker 待补报数据。
// 符号链接不会被跟随；无法读取目录时拒绝接收新工作。
func (l *Ledger) CheckThreadBudget(ctx context.Context, budget int64) error {
	if budget <= 0 {
		budget = DefaultThreadBudgetBytes
	}
	var used int64
	return filepath.WalkDir(l.dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Size() >= budget-used {
				return ErrThreadBudget
			}
			used += info.Size()
		}
		return nil
	})
}

func threadRequestHash(cmd protocol.ThreadCommand) string {
	raw, _ := json.Marshal(cmd)
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func (l *Ledger) threadReceipt(ctx context.Context, id string, cmd protocol.ThreadCommand) (protocol.ThreadCommandResult, bool, error) {
	var hash string
	var raw []byte
	err := l.db.QueryRowContext(ctx, `SELECT request_hash, result FROM thread_command_receipts WHERE message_id=?`, id).Scan(&hash, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.ThreadCommandResult{}, false, nil
	}
	if err != nil {
		return protocol.ThreadCommandResult{}, false, err
	}
	if hash != threadRequestHash(cmd) {
		return protocol.ThreadCommandResult{}, false, errors.New("命令身份冲突")
	}
	var result protocol.ThreadCommandResult
	err = json.Unmarshal(raw, &result)
	return result, true, err
}

func (l *Ledger) saveThreadReceipt(ctx context.Context, id string, cmd protocol.ThreadCommand, result protocol.ThreadCommandResult) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = l.db.ExecContext(ctx, `INSERT INTO thread_command_receipts(message_id,request_hash,result) VALUES(?,?,?)`, id, threadRequestHash(cmd), raw)
	return err
}

func (l *Ledger) insertThread(ctx context.Context, id string, cmd protocol.ThreadCommand) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := l.db.ExecContext(ctx, `INSERT INTO threads(thread_id,session_id,storage_generation,agent_type,
 working_directory,execution_timeout_seconds,open_message_id,status,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,'opening',?,?)`, cmd.ThreadID, cmd.ThreadID, l.generation, cmd.AgentType,
		cmd.WorkingDirectory, cmd.ExecutionTimeoutSeconds, id, now, now)
	return err
}

func (l *Ledger) threadStatus(ctx context.Context, id, status string) error {
	_, err := l.db.ExecContext(ctx, `UPDATE threads SET status=?,updated_at=? WHERE thread_id=?`, status, time.Now().UTC().Format(time.RFC3339Nano), id)
	return err
}

func (l *Ledger) nodeThreadFailure(ctx context.Context, commandID, threadID, kind, reason string) error {
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM thread_node_reports WHERE command_id=?`, commandID).Scan(&exists); err != nil {
		return err
	}
	if exists > 0 {
		return nil
	}
	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT MAX(seq) FROM (
 SELECT COALESCE(MAX(worker_seq),0) AS seq FROM thread_node_reports WHERE thread_id=?
 UNION ALL SELECT COALESCE(MAX(worker_seq),0) FROM thread_report_progress WHERE thread_id=?)`, threadID, threadID).Scan(&seq); err != nil {
		return err
	}
	eventID, err := identity.NewUUID()
	if err != nil {
		return err
	}
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: threadID, EventID: eventID, WorkerSeq: seq + 1, Kind: kind, Reason: reason}
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO thread_node_reports(thread_id,event_id,worker_seq,command_id,report) VALUES(?,?,?,?,?)`, threadID, eventID, r.WorkerSeq, commandID, raw); err != nil {
		return err
	}
	if kind == "thread.open_failed" {
		if _, err := tx.ExecContext(ctx, `UPDATE threads SET status='open_failed',updated_at=? WHERE thread_id=?`, time.Now().UTC().Format(time.RFC3339Nano), threadID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Ledger) nodeThreadPending(ctx context.Context, id string, from int64) ([]protocol.ThreadReport, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT report FROM thread_node_reports WHERE thread_id=? AND acked=0 AND worker_seq>=? ORDER BY worker_seq LIMIT 32`, id, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var reports []protocol.ThreadReport
	for rows.Next() {
		var raw []byte
		var r protocol.ThreadReport
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		reports = append(reports, r)
	}
	return reports, rows.Err()
}

func (l *Ledger) alignMissingThreadReports(ctx context.Context, id string, expected int64) error {
	// node.db 丢失时没有旧序号；中心明确拒绝报告后，以它要求的序号补报终止事实。
	// 有 Worker 映射时始终使用 Worker 原来的序号。
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var mapped int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM threads WHERE thread_id=?`, id).Scan(&mapped); err != nil {
		return err
	}
	if mapped != 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT event_id,worker_seq,report FROM thread_node_reports WHERE thread_id=? AND acked=0 ORDER BY worker_seq`, id)
	if err != nil {
		return err
	}
	type saved struct {
		id     string
		seq    int64
		report protocol.ThreadReport
	}
	var pending []saved
	for rows.Next() {
		var r saved
		var raw []byte
		if err := rows.Scan(&r.id, &r.seq, &raw); err != nil {
			rows.Close()
			return err
		}
		if err := json.Unmarshal(raw, &r.report); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(pending) == 0 || pending[0].seq >= expected {
		return nil
	}
	delta := expected - pending[0].seq
	for i := len(pending) - 1; i >= 0; i-- {
		r := pending[i]
		r.report.WorkerSeq += delta
		raw, err := json.Marshal(r.report)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE thread_node_reports SET worker_seq=?,report=? WHERE event_id=?`, r.report.WorkerSeq, raw, r.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Ledger) noteThreadSeq(ctx context.Context, id string, seq int64) error {
	_, err := l.db.ExecContext(ctx, `INSERT INTO thread_report_progress(thread_id,worker_seq) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET worker_seq=MAX(worker_seq,excluded.worker_seq)`, id, seq)
	return err
}

func validateThreadDirectory(dir, path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("工作目录必须是绝对路径")
	}
	roots, err := ListBrowseRoots(dir)
	if err != nil {
		return errors.New("无法读取已登记目录")
	}
	for _, root := range roots {
		candidates := []string{root.Path}
		if real, err := filepath.EvalSymlinks(root.Path); err == nil && real != root.Path {
			candidates = append(candidates, real)
		}
		for _, base := range candidates {
			rel, err := filepath.Rel(base, path)
			if err != nil || !filepath.IsLocal(rel) {
				continue
			}
			opened, err := os.OpenRoot(root.Path)
			if err != nil {
				continue
			}
			child, err := opened.OpenRoot(rel)
			opened.Close()
			if err == nil {
				child.Close()
				return nil
			}
		}
	}
	return errors.New("工作目录不存在或位于已登记目录之外")
}
