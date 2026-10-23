package session

import (
	"context"
	"database/sql"
	"errors"
)

// ResumeThread 恢复已有原生会话，成功后报告 idle，再处理仍在排队的消息。
func (w *ThreadWorker) ResumeThread(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	state, err := w.status()
	if err != nil {
		return err
	}
	if w.options.AgentType == "shell" || (state != "stopped" && state != "idle") {
		return errors.New("当前 Thread 不能恢复")
	}
	turn, err := w.active()
	if err != nil {
		return err
	}
	if turn != 0 {
		return errors.New("当前一轮尚未结束")
	}
	var stopping int64
	if err := w.db.QueryRow(`SELECT stop_requested_at FROM thread_meta`).Scan(&stopping); err != nil {
		return err
	}
	if stopping != 0 {
		return errors.New("Thread 正在停止")
	}
	if state == "stopped" || w.adapter == nil {
		if err := w.startAdapter(ctx, true); err != nil {
			if saveErr := w.transaction(func(tx *sql.Tx) error { return w.stateReport(tx, "stopped", "thread.stopped", err.Error()) }); saveErr != nil {
				return saveErr
			}
			return err
		}
	}
	if err := w.transaction(func(tx *sql.Tx) error { return w.stateReport(tx, "idle", "thread.resumed", "") }); err != nil {
		return err
	}
	return w.sendNext(ctx)
}
