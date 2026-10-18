package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/task"
)

func ensureChildSchema(w *workerDB) error {
	_, err := w.db.Exec(`CREATE TABLE IF NOT EXISTS child_deliveries (
      delivery_id TEXT PRIMARY KEY, child_task_id TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, input_generation INTEGER NOT NULL DEFAULT 0)`)
	return err
}

// ReceiveChild 不会启动或恢复 Agent。自动继续只允许当前存活回合明确等待子结果。
func (w *workerDB) ReceiveChild(sessionID string, delivery protocol.ChildDelivery, queried bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, id := range []string{delivery.DeliveryID, delivery.ChildTaskID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return errors.New("交付标识无效")
		}
	}
	if delivery.TaskID != w.task || delivery.ExecutionID != w.execution || delivery.SessionID != sessionID || !json.Valid(delivery.Result) || len(delivery.Result) > task.ExecutorInputLimit {
		return errors.New("交付上下文不匹配")
	}
	inserted, err := w.db.Exec(`INSERT INTO child_deliveries (delivery_id, child_task_id, payload, status)
      VALUES (?, ?, ?, 'available') ON CONFLICT (delivery_id) DO NOTHING`, delivery.DeliveryID, delivery.ChildTaskID, string(delivery.Result))
	if err != nil {
		return err
	}
	if n, err := inserted.RowsAffected(); err != nil {
		return err
	} else if n == 1 {
		CrashAfter("delivery_received")
	}
	var state, savedChild, payload string
	if err := w.db.QueryRow(`SELECT status, child_task_id, payload FROM child_deliveries WHERE delivery_id = ?`, delivery.DeliveryID).Scan(&state, &savedChild, &payload); err != nil {
		return err
	}
	if savedChild != delivery.ChildTaskID {
		return errors.New("交付身份冲突")
	}
	if state == "delivered" || state == "uncertain" {
		return nil
	}
	var stopped string
	if err := w.db.QueryRow(`SELECT COALESCE((SELECT value FROM meta WHERE key = 'agent_stopped'), '')`).Scan(&stopped); err != nil {
		return err
	}
	if stopped == "1" || w.cancelled || w.resultDelivered || w.recoveredUncertain || w.generation < 1 {
		_, err := w.db.Exec(`UPDATE child_deliveries SET status = 'source_stopped' WHERE delivery_id = ?`, delivery.DeliveryID)
		return err
	}
	if w.deliveryUncertain {
		return nil
	}
	var waiting string
	if err := w.db.QueryRow(`SELECT COALESCE((SELECT value FROM meta WHERE key = 'waiting_children'), '')`).Scan(&waiting); err != nil {
		return err
	}
	if !queried && waiting != "1" {
		return nil
	}
	if reason, err := w.deadlineReasonLocked(); err != nil {
		return err
	} else if reason != "" {
		_, err := w.stopLocked(sessionID, reason)
		return err
	}
	tx, err := w.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	generation := w.generation + 1
	// 意图先于任何交付输入；恢复时不重放这个不可判定窗口。
	if _, err := tx.Exec(`UPDATE child_deliveries SET status = 'uncertain', input_generation = ? WHERE delivery_id = ?`, generation, delivery.DeliveryID); err != nil {
		return err
	}
	if err := putMeta(tx, "input_generation", fmt.Sprint(generation)); err != nil {
		return err
	}
	if err := putMeta(tx, "waiting_children", "0"); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE outbox SET delivered = 1 WHERE kind = ?`, protocol.ReportResult); err != nil {
		return err
	}
	if err := insertLog(tx, "delivery_intent", delivery.DeliveryID, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	w.generation = generation
	w.deliveryUncertain = true
	CrashAfter("delivery_intent")
	if !queried {
		delivery.Result = json.RawMessage(payload)
		input, err := json.Marshal(delivery)
		if err != nil {
			return err
		}
		out, err := w.observer.DeliverResult(context.Background(), delivery.DeliveryID, string(input))
		if err != nil {
			return nil
		}
		CrashAfter("delivery_send")
		if _, err := w.recordExecution(sessionID, string(input), out); err != nil {
			return err
		}
	}
	// 测试适配器返回已写入原生历史；真实适配器必须提供同样的确认。
	confirmed, err := w.db.Begin()
	if err != nil {
		return err
	}
	defer confirmed.Rollback()
	if err := insertLog(confirmed, "delivery_confirmed", delivery.DeliveryID, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	_, err = confirmed.Exec(`UPDATE child_deliveries SET status = 'delivered' WHERE delivery_id = ?`, delivery.DeliveryID)
	if err != nil {
		return err
	}
	err = confirmed.Commit()
	if err == nil {
		w.deliveryUncertain = false
	}
	if err == nil {
		CrashAfter("delivery_saved")
	}
	return err
}

func (w *workerDB) ChildReceipts() ([]protocol.ChildReceipt, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	rows, err := w.db.Query(`SELECT delivery_id, status, input_generation FROM child_deliveries ORDER BY input_generation, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []protocol.ChildReceipt
	for rows.Next() {
		var r protocol.ChildReceipt
		if err := rows.Scan(&r.DeliveryID, &r.Status, &r.Generation); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (c *Client) ReceiveChild(delivery protocol.ChildDelivery, queried bool) (Status, error) {
	return c.roundTrip(ipcMessage{Type: "child_delivery", ChildDelivery: &delivery, Queried: queried})
}

func (h *Host) ReceiveChild(ctx context.Context, sessionID string, delivery protocol.ChildDelivery, queried bool) (Status, error) {
	return h.call(ctx, sessionID, func(c *Client) (Status, error) { return c.ReceiveChild(delivery, queried) })
}
