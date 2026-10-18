package session

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/pi"
)

// configureAdapter is the only Worker selection point. Other native Agents can
// implement agent.Adapter without changing the Worker lifecycle or its ledger.
func configureAdapter(w *workerDB, dataDir, sessionID string) {
	if os.Getenv("BATON_TEST_EXECUTOR_LOG") != "" && os.Getenv("BATON_AGENT_DRIVER") != "native" {
		return
	}
	w.adapterFactory = func(agentType, payload string) (agent.Adapter, error) {
		var input struct {
			WorkingDirectory string `json:"working_directory"`
		}
		if json.Unmarshal([]byte(payload), &input) != nil {
			return nil, errors.New("任务输入无效")
		}
		dir, err := SessionDir(dataDir, sessionID)
		if err != nil {
			return nil, err
		}
		if input.WorkingDirectory == "" {
			input.WorkingDirectory = filepath.Join(dir, "workspace")
			if err := os.MkdirAll(input.WorkingDirectory, 0o700); err != nil {
				return nil, err
			}
		}
		contextFile, err := AgentContextPath(dataDir, sessionID, w.execution)
		if err != nil {
			return nil, err
		}
		config := agent.Config{Directory: input.WorkingDirectory, SessionDir: filepath.Join(dir, "native"), SessionID: sessionID, ContextFile: contextFile}
		if _, err := os.Lstat(config.SessionDir); err == nil {
			config.Restore = true
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		switch agentType {
		case "pi":
			config.Model, config.Binary = os.Getenv("BATON_PI_MODEL"), os.Getenv("BATON_PI_BIN")
			if home := os.Getenv("BATON_PI_HOME"); home != "" {
				config.Env = pi.IsolatedEnv(home)
			}
			return pi.New(config), nil
		default:
			return nil, errors.New("尚未实现的 Agent 适配器")
		}
	}
}

func (w *workerDB) pollAdapterLocked(sessionID string) error {
	if w.adapter == nil {
		return nil
	}
	if err := w.confirmNativeDeliveriesLocked(); err != nil {
		return err
	}
	for _, out := range w.adapter.Drain() {
		if w.cancelled || w.recoveredUncertain {
			continue
		}
		if uncertain, err := w.finishNativeChecksLocked(); err != nil {
			return err
		} else if uncertain {
			out = Output{Uncertain: true, Exited: out.Exited}
		}
		if _, err := w.recordExecution(sessionID, "", out); err != nil {
			return err
		}
	}
	return nil
}

func (w *workerDB) confirmNativeDeliveriesLocked() error {
	rows, err := w.db.Query(`SELECT delivery_id, queried FROM native_delivery_checks`)
	if err != nil {
		return err
	}
	type check struct {
		id      string
		queried bool
	}
	var checks []check
	for rows.Next() {
		var c check
		if err := rows.Scan(&c.id, &c.queried); err != nil {
			rows.Close()
			return err
		}
		checks = append(checks, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, c := range checks {
		confirmed, err := w.adapter.HistoryContains(c.id, c.queried)
		if err != nil || !confirmed {
			continue
		}
		tx, err := w.db.Begin()
		if err != nil {
			return err
		}
		if err = insertLog(tx, "delivery_confirmed", c.id, time.Now().UTC().Format(time.RFC3339Nano)); err == nil {
			_, err = tx.Exec(`UPDATE child_deliveries SET status = 'delivered' WHERE delivery_id = ?`, c.id)
		}
		if err == nil {
			_, err = tx.Exec(`DELETE FROM native_delivery_checks WHERE delivery_id = ?`, c.id)
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	var uncertain int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM child_deliveries WHERE status='uncertain'`).Scan(&uncertain); err != nil {
		return err
	}
	w.deliveryUncertain = uncertain > 0
	return nil
}

func (w *workerDB) finishNativeChecksLocked() (bool, error) {
	res, err := w.db.Exec(`DELETE FROM native_delivery_checks`)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if n > 0 {
		w.deliveryUncertain = true
	}
	return n > 0, err
}
