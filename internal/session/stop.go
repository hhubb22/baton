package session

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/task"
)

func (w *workerDB) deadlineReasonLocked() (string, error) {
	if !w.intent || w.executionBudget <= 0 || w.cancelled || w.hasResultLocked() {
		return "", nil
	}
	mono, err := w.executionClock.Mono()
	if err != nil {
		return "", err
	}
	elapsed := mono - w.startedMono
	if !w.inputSubmitted && w.queueBudget > 0 && elapsed >= w.queueBudget && w.queueBudget < w.executionBudget {
		return task.CodeQueueTimeout, nil
	}
	if elapsed >= w.executionBudget {
		return task.CodeExecutionTimeout, nil
	}
	return "", nil
}

func (w *workerDB) checkDeadline(sessionID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.pollAdapterLocked(sessionID); err != nil {
		return err
	}
	if w.cancelled && w.stopReason != "" && !w.stopReported {
		_, err := w.stopLocked(sessionID, w.stopReason)
		return err
	}
	reason, err := w.deadlineReasonLocked()
	if err != nil {
		return err
	}
	if reason != "" {
		_, err = w.stopLocked(sessionID, reason)
	}
	return err
}

// Stop 与授权及输入共用 Session 互斥区。接口返回、停止事实和结果已知是三个不同概念。
func (w *workerDB) Stop(sessionID, reason string) ([]ipcReport, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stopLocked(sessionID, reason)
}

func (w *workerDB) stopLocked(sessionID, reason string) ([]ipcReport, error) {
	if reason == task.CodeQueueTimeout && w.inputSubmitted && !w.recoveredUncertain {
		return w.pendingLocked()
	}
	switch reason {
	case task.StatusCancelled, task.CodeQueueTimeout, task.CodeExecutionTimeout:
	default:
		return nil, errors.New("中止原因无效")
	}
	if sessionID == "" {
		sessionID = w.sessionID
	}
	var count int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE kind = ?`, task.EventStopReport).Scan(&count); err != nil {
		return nil, err
	}
	if count > 0 {
		w.stopReported = true
		return w.pendingLocked()
	}
	if w.stopReason != "" {
		reason = w.stopReason
	}
	tx, err := w.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := putMeta(tx, "start_cancelled", "1"); err != nil {
		return nil, err
	}
	if err := putMeta(tx, "stop_reason", reason); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	w.cancelled, w.stopReason = true, reason
	if _, err := w.finishNativeChecksLocked(); err != nil {
		return nil, err
	}
	notStarted := !w.inputSubmitted && !w.recoveredUncertain
	stopped, known := notStarted, notStarted
	if w.hasResultLocked() {
		var payload string
		if err := w.db.QueryRow(`SELECT payload FROM outbox WHERE kind = ? ORDER BY rowid DESC LIMIT 1`, protocol.ReportResult).Scan(&payload); err != nil {
			return nil, err
		}
		var result protocol.ExecutionReport
		if err := json.Unmarshal([]byte(payload), &result); err != nil {
			return nil, err
		}
		stopped = result.AgentStopped
		known = stopped && (result.Status == task.StatusCompleted || result.Status == task.StatusFailed)
		notStarted = false
	} else if !notStarted && (w.adapter != nil || !w.recoveredUncertain) {
		if w.adapter != nil {
			stopped, known, err = w.adapter.Abort()
		} else if w.adapterFactory == nil {
			stopped, known, err = w.observer.Abort()
		}
		if err != nil {
			stopped, known = false, false
		}
	}
	return w.recordStopReportLocked(sessionID, stopped, known, notStarted)
}

func (w *workerDB) recordStopReportLocked(sessionID string, stopped, known, notStarted bool) ([]ipcReport, error) {
	var previous string
	err := w.db.QueryRow(`SELECT payload FROM outbox WHERE kind = ? ORDER BY rowid DESC LIMIT 1`, task.EventStopReport).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if previous != "" {
		var report protocol.ExecutionReport
		if err := json.Unmarshal([]byte(previous), &report); err != nil {
			return nil, err
		}
		if !stopped || report.AgentStopped {
			w.stopReported = true
			return w.pendingLocked()
		}
	}
	eventID, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(protocol.ExecutionReport{
		Type: protocol.BodyExecutionReport, EventID: eventID, TaskID: w.task, ExecutionID: w.execution,
		SessionID: sessionID, Kind: task.EventStopReport, InputGeneration: w.generation,
		Status: task.StatusNeedsVerification, OccurredAt: w.executionClock.Wall().UTC(),
		StopReason: w.stopReason, AgentStopped: stopped, OutcomeKnown: known, NotStarted: notStarted,
	})
	if err != nil {
		return nil, err
	}
	tx, err := w.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	kind, message := "stop", "已请求中止；停止不回滚外部副作用"
	if previous != "" {
		kind, message = "stop_confirmed", "已观察到 Agent 停止；停止不回滚外部副作用"
	}
	if err := insertLog(tx, kind, message, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return nil, err
	}
	if stopped {
		if err := putMeta(tx, "agent_stopped", "1"); err != nil {
			return nil, err
		}
	}
	if err := insertOutbox(tx, eventID, task.EventStopReport, body); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	w.stopReported = true
	return w.pendingLocked()
}
