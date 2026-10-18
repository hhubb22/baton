package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/pi"
	"baton/internal/task"
)

type adapterRegistration struct {
	new                          func(agent.Config) agent.Adapter
	modelEnv, binaryEnv, homeEnv string
}

var registeredAdapters = map[string]adapterRegistration{
	"pi":    {func(c agent.Config) agent.Adapter { return pi.New(c) }, "BATON_PI_MODEL", "BATON_PI_BIN", "BATON_PI_HOME"},
	"codex": {func(c agent.Config) agent.Adapter { return codex.New(c) }, "BATON_CODEX_MODEL", "BATON_CODEX_BINARY", "BATON_CODEX_HOME"},
}

// configureAdapter is the only Worker selection point. Other native Agents can
// implement agent.Adapter without changing the Worker lifecycle or its ledger.
func configureAdapter(w *workerDB, dataDir, sessionID string) {
	if os.Getenv("BATON_TEST_EXECUTOR_LOG") != "" && os.Getenv("BATON_AGENT_DRIVER") != "native" {
		return
	}
	w.adapterFactory = func(agentType, payload string) (agent.Adapter, error) {
		registration, ok := registeredAdapters[agentType]
		if !ok {
			return nil, errors.New("尚未实现的 Agent 适配器")
		}
		var saved string
		var config agent.Config
		err := w.db.QueryRow(`SELECT value FROM meta WHERE key = 'adapter_config'`).Scan(&saved)
		if err == nil {
			if json.Unmarshal([]byte(saved), &config) != nil || config.SessionID != sessionID || config.ExecutionID != w.execution {
				return nil, agent.ErrHistoryMissing
			}
			config.Restore = true
			return registration.new(config), nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if payload == "" {
			return nil, agent.ErrHistoryMissing
		}
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
		config = agent.Config{Directory: input.WorkingDirectory, SessionDir: filepath.Join(dir, "native"), SessionID: sessionID, ExecutionID: w.execution, ContextFile: contextFile}
		config.StatePath = filepath.Join(config.SessionDir, "state.json")
		if _, err := os.Lstat(config.SessionDir); err == nil {
			config.Restore = true
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		config.Model, config.Binary, config.Home = os.Getenv(registration.modelEnv), os.Getenv(registration.binaryEnv), os.Getenv(registration.homeEnv)
		raw, err := json.Marshal(config)
		if err != nil {
			return nil, err
		}
		if _, err := w.db.Exec(`INSERT INTO meta (key,value) VALUES ('adapter_config',?)`, string(raw)); err != nil {
			return nil, err
		}
		return registration.new(config), nil
	}
}

func (w *workerDB) restoreAdapter(sessionID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.adapterFactory == nil || !w.inputSubmitted {
		return nil
	}
	var agentType string
	err := w.db.QueryRow(`SELECT value FROM meta WHERE key = 'agent_type'`).Scan(&agentType)
	if err == nil {
		w.adapter, err = w.adapterFactory(agentType, "")
	}
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err = w.adapter.Start(ctx)
	}
	if err != nil {
		if w.adapter != nil {
			_ = w.adapter.Close()
			w.adapter = nil
		}
		if !w.hasResultLocked() && !w.resultDelivered {
			w.recoveredUncertain, w.uncertainCode = true, task.CodeUncertainHistory
		}
		return nil
	}
	return w.pollAdapterLocked(sessionID)
}

func (w *workerDB) readNativeHistory(cursor string) (agent.HistoryPage, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.adapter == nil {
		return agent.HistoryPage{}, agent.ErrHistoryMissing
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return w.adapter.ReadHistory(ctx, cursor)
}

func (w *workerDB) pollAdapterLocked(sessionID string) error {
	if w.adapter == nil {
		return nil
	}
	if live, ok := w.adapter.(agent.LiveAdapter); ok {
		text, gap := live.DrainLive()
		w.appendLiveLocked(text, gap)
	}
	if err := w.confirmNativeDeliveriesLocked(); err != nil {
		return err
	}
	for _, out := range w.adapter.Drain() {
		if len(out.Raw) > 0 {
			if _, err := w.db.Exec(`INSERT INTO execution_log(kind,body,created_at) VALUES('native_event',?,?)`, string(out.Raw), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
		}
		if w.cancelled || w.hasResultLocked() || w.resultDelivered {
			continue
		}
		if out.Final == "" && !out.Exited && !out.Uncertain && !out.WaitingForChildren && len(out.Progress) == 0 {
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
		if !out.Uncertain && (out.Exited || out.WaitingForChildren) {
			w.recoveredUncertain = false
		}
	}
	if w.cancelled && w.stopReason != "" {
		if observer, ok := w.adapter.(agent.StopObserver); ok {
			if stopped, known := observer.StopStatus(); stopped {
				_, err := w.recordStopReportLocked(sessionID, true, known, false)
				return err
			}
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
