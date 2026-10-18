package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/task"
)

func (c *Client) SubmitResult(taskID, executionID, candidate string) (Status, error) {
	return c.roundTrip(ipcMessage{Type: "submit_result", TaskID: taskID, ExecutionID: executionID, Payload: candidate})
}

func (h *Host) SubmitResult(ctx context.Context, sessionID, taskID, executionID, candidate string) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) {
		return c.SubmitResult(taskID, executionID, candidate)
	})
}

func (w *workerDB) SubmitResult(sessionID, taskID, executionID, raw string) ([]ipcReport, error) {
	candidate, err := task.ParseCandidate(raw)
	if err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(candidate)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(canonical)
	digest := hex.EncodeToString(hash[:])
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.task != taskID || w.execution != executionID || !w.intent || !w.inputSubmitted || !w.inputResolved {
		return nil, errors.New("当前执行尚未接受输入")
	}
	var saved string
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'agent_result_hash'`).Scan(&saved)
	if saved != "" {
		if saved != digest {
			return nil, errors.New("候选结果与已保存内容冲突")
		}
		return w.pendingLocked()
	}
	var results int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, protocol.ReportResult).Scan(&results); err != nil {
		return nil, err
	}
	if results != 0 || w.cancelled || w.recoveredUncertain {
		return nil, errors.New("当前执行已有结果或已中止")
	}
	if reason, err := w.deadlineReasonLocked(); err != nil {
		return nil, err
	} else if reason != "" {
		return w.stopLocked(sessionID, reason)
	}
	stopped, _, err := w.observer.Abort()
	if err != nil || !stopped {
		return nil, errors.New("尚未确认执行器停止")
	}
	eventID, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(reportFromCandidate(eventID, w.task, w.execution, sessionID, w.generation, candidate, stopped))
	if err != nil {
		return nil, err
	}
	tx, err := w.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := putMeta(tx, "agent_result_hash", digest); err != nil {
		return nil, err
	}
	if err := insertLog(tx, "output", raw, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return nil, err
	}
	if err := insertOutbox(tx, eventID, protocol.ReportResult, body); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return w.pendingLocked()
}
