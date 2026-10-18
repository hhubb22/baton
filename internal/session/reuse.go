package session

import (
	"baton/internal/agent"
	"encoding/json"
	"errors"
	"time"
)

// reuseLocked 仅在员工显式恢复且原结果已确认交付后准备下一份执行。
func (w *workerDB) reuseLocked(taskID, executionID, agentType string) error {
	var resumed, oldAgent string
	if err := w.db.QueryRow(`SELECT COALESCE((SELECT value FROM meta WHERE key='browser_resumed'),'0')`).Scan(&resumed); err != nil {
		return err
	}
	if resumed != "1" || !w.resultDelivered || w.recoveredUncertain || w.deliveryUncertain {
		return ErrSessionBusy
	}
	if err := w.db.QueryRow(`SELECT value FROM meta WHERE key='agent_type'`).Scan(&oldAgent); err != nil {
		return err
	}
	if oldAgent != agentType {
		return ErrSessionBusy
	}
	var pending int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE delivered=0`).Scan(&pending); err != nil {
		return err
	}
	if pending != 0 {
		return ErrSessionBusy
	}
	var saved string
	if err := w.db.QueryRow(`SELECT value FROM meta WHERE key='adapter_config'`).Scan(&saved); err != nil {
		return errors.New("原生 Session 配置缺失")
	}
	var config agent.Config
	if json.Unmarshal([]byte(saved), &config) != nil {
		return errors.New("原生 Session 配置无效")
	}
	config.ExecutionID = executionID
	contextFile, err := AgentContextPath(w.dataDir, config.SessionID, executionID)
	if err != nil {
		return err
	}
	config.ContextFile = contextFile
	config.Restore = true
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	tx, err := w.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM meta`); err != nil {
		return err
	}
	for key, value := range map[string]string{"execution_id": executionID, "task_id": taskID, "agent_type": agentType, "adapter_config": string(raw)} {
		if err = putMeta(tx, key, value); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`DELETE FROM outbox`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM child_deliveries`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM native_delivery_checks`); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if w.adapter != nil {
		_ = w.adapter.Close()
		w.adapter = nil
	}
	w.execution, w.task = executionID, taskID
	w.nonce, w.nodeID, w.stopReason = "", "", ""
	w.armedMono, w.generation = 0, 0
	w.intent, w.cancelled, w.inputSubmitted, w.inputResolved, w.resultDelivered, w.recoveredUncertain, w.deliveryUncertain, w.stopReported = false, false, false, false, false, false, false, false
	w.uncertainCode = ""
	w.startedMono, w.executionBudget, w.queueBudget, w.inputDelay = 0, 0, 0, 0
	w.inputDueAt, w.inputSentAt = time.Time{}, time.Time{}
	return nil
}
