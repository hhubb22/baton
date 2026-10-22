package node

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"baton/internal/protocol"
	"baton/internal/session"
)

// 未确认的 Worker 报告保留在 node.db，原 Worker 账本不可读时仍按原身份补报。
func (l *Ledger) cacheThreadWorkerReports(ctx context.Context, id string, reports []protocol.ThreadReport) error {
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, report := range reports {
		if report.ThreadID != id || report.EventID == "" || report.WorkerSeq < 1 {
			return errors.New("Worker 报告身份或序号无效")
		}
		raw, err := json.Marshal(report)
		if err != nil {
			return err
		}
		var saved []byte
		err = tx.QueryRowContext(ctx, `SELECT report FROM thread_worker_reports WHERE thread_id=? AND worker_seq=?`, id, report.WorkerSeq).Scan(&saved)
		if err == nil {
			if string(saved) != string(raw) {
				return errors.New("Worker 报告内容发生冲突")
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO thread_worker_reports(thread_id,event_id,worker_seq,report) VALUES(?,?,?,?)`, id, report.EventID, report.WorkerSeq, raw); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (l *Ledger) cachedThreadWorkerReports(ctx context.Context, id string, from int64) ([]protocol.ThreadReport, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT report FROM thread_worker_reports WHERE thread_id=? AND worker_seq>=? ORDER BY worker_seq LIMIT 32`, id, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var reports []protocol.ThreadReport
	for rows.Next() {
		var raw []byte
		var report protocol.ThreadReport
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &report); err != nil {
			return nil, err
		}
		reports = append(reports, report)
	}
	return reports, rows.Err()
}

// 只有明确缺失或损坏的 Worker 账本才生成历史不可恢复报告。
func (l *Ledger) threadHistoryFailure(ctx context.Context, id string, failure error) (bool, error) {
	var reason string
	switch {
	case errors.Is(failure, session.ErrHistoryMissing):
		reason = "本地 Thread 历史缺失"
	case errors.Is(failure, session.ErrHistoryIncompatible):
		reason = "本地 Thread 历史损坏或不兼容"
	default:
		return false, nil
	}
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return true, err
	}
	defer tx.Rollback()
	if err := l.nodeThreadFailureTx(ctx, tx, "history:"+id, id, "thread.stopped", reason, true); err != nil {
		return true, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE threads SET status='history_missing' WHERE thread_id=?`, id); err != nil {
		return true, err
	}
	return true, tx.Commit()
}
