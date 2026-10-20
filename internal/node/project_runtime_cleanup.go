package node

import (
	"context"
	"database/sql"
	"time"

	"baton/internal/delivery"
	"baton/internal/protocol"
)

const projectReceiptTimeout = 5 * time.Second

func execProjectRuntime(parent context.Context, db *sql.DB, query string, args ...any) (sql.Result, error) {
	ctx, cancel := context.WithTimeout(parent, time.Second)
	defer cancel()
	return db.ExecContext(ctx, query, args...)
}

// 旧账本的终态也不能证明本地收尾已完成，新增字段一律保守初始化。
func ensureProjectRuntimeCleanup(db *sql.DB) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `PRAGMA table_info(project_runtime_runs)`)
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, column := range []string{"cleanup_complete", "cleanup_acked", "cleanup_next_at", "cleanup_attempts"} {
		if !columns[column] {
			if _, err := tx.ExecContext(ctx, `ALTER TABLE project_runtime_runs ADD COLUMN `+column+` INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS project_runtime_cleanup_due ON project_runtime_runs(cleanup_next_at,run_id) WHERE cleanup_complete=1 AND cleanup_acked=0`); err != nil {
		return err
	}
	return tx.Commit()
}

func (m *projectRuntimeManager) signalCleanup() {
	select {
	case m.cleanupReady <- struct{}{}:
	default:
	}
}

// 调用者已等待 Process.Wait、IPC 收尾和控制目录删除。失败时保留 map 中的证据，
// 与活动进程共用 4-run 上限，避免数据库故障期间积累无界内存。
func (m *projectRuntimeManager) persistCleanup(parent context.Context, p *projectRuntimeProcess) {
	command := p.command
	result, err := execProjectRuntime(parent, m.ledger.db, `UPDATE project_runtime_runs SET
		state=CASE WHEN state='failed' THEN state ELSE 'exited' END,
		reason=CASE WHEN reason='' THEN 'runtime_exited' ELSE reason END,
		cleanup_complete=1
		WHERE run_id=? AND lease_epoch=?`, command.RunID, command.LeaseEpoch)
	if err != nil {
		return
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return
	}
	m.mu.Lock()
	if m.runs[command.RunID] == p {
		delete(m.runs, command.RunID)
	}
	m.mu.Unlock()
	m.signalCleanup()
}

func (m *projectRuntimeManager) persistPendingCleanup() {
	m.mu.Lock()
	var pending []*projectRuntimeProcess
	for _, p := range m.runs {
		if p.cleanupPending {
			pending = append(pending, p)
		}
	}
	m.mu.Unlock()
	for _, p := range pending {
		if m.ctx.Err() != nil {
			return
		}
		m.persistCleanup(m.ctx, p)
	}
}

type projectCleanupReceipt struct {
	command protocol.ProjectRunCommand
	reason  string
}

// 领取事务先保存调用期限及退避，断线、超时和补送期间崩溃均沿用该到期时间。
func claimProjectCleanup(ctx context.Context, db *sql.DB, now time.Time) (projectCleanupReceipt, error) {
	var receipt projectCleanupReceipt
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback()
	var attempts int
	err = tx.QueryRowContext(ctx, `SELECT run_id,lease_epoch,reason,cleanup_attempts FROM project_runtime_runs
		WHERE cleanup_complete=1 AND cleanup_acked=0 AND cleanup_next_at<=?
		ORDER BY cleanup_next_at,run_id LIMIT 1`, now.UnixMilli()).Scan(&receipt.command.RunID, &receipt.command.LeaseEpoch, &receipt.reason, &attempts)
	if err != nil {
		return receipt, err
	}
	next := delivery.NextAttempt(now.Add(projectReceiptTimeout), attempts+1, time.Second)
	if _, err = tx.ExecContext(ctx, `UPDATE project_runtime_runs SET cleanup_attempts=cleanup_attempts+1,cleanup_next_at=? WHERE run_id=?`, next.UnixMilli(), receipt.command.RunID); err != nil {
		return receipt, err
	}
	return receipt, tx.Commit()
}

func sendProjectCleanup(ctx context.Context, receipt projectCleanupReceipt, call func(context.Context, protocol.ProjectRuntimeRequest) protocol.ProjectRuntimeResult) bool {
	ctx, cancel := context.WithTimeout(ctx, projectReceiptTimeout)
	defer cancel()
	req := protocol.ProjectRuntimeRequest{RunID: receipt.command.RunID, LeaseEpoch: receipt.command.LeaseEpoch, Operation: "exited", Reason: receipt.reason}
	result := call(ctx, req)
	if !result.OK && result.Code != "lease_lost" {
		return false
	}
	req.Operation, req.Reason = "stopped", ""
	return call(ctx, req).OK
}

func (m *projectRuntimeManager) cleanupReceiptLoop() {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.cleanupReady:
		case <-ticker.C:
		}
		m.persistPendingCleanup()
		for range 32 {
			if m.ctx.Err() != nil {
				return
			}
			ctx, cancel := context.WithTimeout(m.ctx, time.Second)
			receipt, err := claimProjectCleanup(ctx, m.ledger.db, time.Now())
			cancel()
			if err != nil {
				break
			}
			if sendProjectCleanup(m.ctx, receipt, m.call) {
				_, _ = execProjectRuntime(m.ctx, m.ledger.db, `UPDATE project_runtime_runs SET cleanup_acked=1 WHERE run_id=? AND lease_epoch=? AND cleanup_complete=1`, receipt.command.RunID, receipt.command.LeaseEpoch)
			}
		}
	}
}
