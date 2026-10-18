package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"baton/internal/adapters/codex"
	"baton/internal/task"
)

func (w *workerDB) usesCodex() bool { return w.runtimeDataDir != "" && w.agentType == "codex" }

func (w *workerDB) codexConfig(sessionID, directory string) (codex.Config, error) {
	if !filepath.IsAbs(directory) {
		return codex.Config{}, errors.New("Codex requires an explicit absolute working_directory")
	}
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return codex.Config{}, errors.New("Codex working_directory is unavailable")
	}
	stateDir, err := SessionDir(w.runtimeDataDir, sessionID)
	if err != nil {
		return codex.Config{}, err
	}
	contextFile, err := AgentContextPath(w.runtimeDataDir, sessionID, w.execution)
	if err != nil {
		return codex.Config{}, err
	}
	return codex.Config{Binary: os.Getenv("BATON_CODEX_BINARY"), Model: os.Getenv("BATON_CODEX_MODEL"), Home: os.Getenv("BATON_CODEX_HOME"), Directory: directory, SessionID: sessionID, StatePath: filepath.Join(stateDir, "codex.json"), ContextFile: contextFile}, nil
}

func (w *workerDB) submitCodexLocked(sessionID, payload string) (Output, error) {
	var input struct {
		WorkingDirectory string `json:"working_directory"`
		Description      string `json:"description"`
		Generation       int    `json:"generation"`
	}
	if json.Unmarshal([]byte(payload), &input) != nil || input.Description == "" || input.Generation != 1 || len(payload) > task.ExecutorInputLimit {
		return Output{}, errors.New("invalid Codex input")
	}
	c, err := w.codexConfig(sessionID, input.WorkingDirectory)
	if err != nil {
		return Output{}, err
	}
	if w.native != nil {
		return Output{}, codex.ErrUncertain
	}
	// This binding is committed before creating the native thread.
	tx, err := w.db.Begin()
	if err != nil {
		return Output{}, err
	}
	defer tx.Rollback()
	for key, value := range map[string]string{"codex_directory": c.Directory, "codex_model": c.Model, "codex_home": c.Home} {
		if err := putMeta(tx, key, value); err != nil {
			return Output{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Output{}, err
	}
	w.native = codex.New(c)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := w.native.CreateSession(ctx); err != nil {
		return Output{}, err
	}
	if err := w.native.StartTask(ctx, w.execution+":1", payload); err != nil {
		return Output{}, err
	}
	return Output{}, nil
}

func (w *workerDB) restoreCodex(sessionID string) error {
	if !w.usesCodex() || !w.inputSubmitted {
		return nil
	}
	var directory string
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'codex_directory'`).Scan(&directory)
	c, err := w.codexConfig(sessionID, directory)
	if err != nil {
		return w.codexVerification(sessionID)
	}
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'codex_model'`).Scan(&c.Model)
	_ = w.db.QueryRow(`SELECT value FROM meta WHERE key = 'codex_home'`).Scan(&c.Home)
	w.native = codex.New(c)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := w.native.Attach(ctx); err != nil {
		_ = w.native.Close()
		w.native = nil
		return w.codexVerification(sessionID)
	}
	return nil
}

func (w *workerDB) codexVerification(sessionID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.hasResultLocked() || w.resultDelivered {
		return nil
	}
	w.recoveredUncertain = true
	w.uncertainCode = task.CodeUncertainHistory
	_, err := w.ensureVerificationLocked(sessionID)
	return err
}

func (w *workerDB) pollCodex(sessionID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.native == nil {
		return nil
	}
	for {
		select {
		case event := <-w.native.Events():
			if len(event.Raw) > 0 {
				if _, err := w.db.Exec(`INSERT INTO execution_log(kind,body,created_at) VALUES('codex_event',?,?)`, string(event.Raw), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
					return err
				}
			}
			if event.ConfirmedInput != "" {
				if _, err := w.db.Exec(`UPDATE child_deliveries SET status='delivered' WHERE delivery_id=? AND status='uncertain'`, event.ConfirmedInput); err != nil {
					return err
				}
				var count int
				if err := w.db.QueryRow(`SELECT COUNT(*) FROM child_deliveries WHERE status='uncertain'`).Scan(&count); err != nil {
					return err
				}
				w.deliveryUncertain = count > 0
			}
			if event.Uncertain && !w.hasResultLocked() && !w.resultDelivered {
				w.uncertainCode = task.CodeUncertainWorker
				if _, err := w.ensureVerificationLocked(sessionID); err != nil {
					return err
				}
			} else if event.Settled && !w.hasResultLocked() && !w.deliveryUncertain {
				if _, err := w.recordExecution(sessionID, "", Output{Final: event.Final, Exited: true}); err != nil {
					return err
				}
				w.recoveredUncertain = false
			}
		default:
			return nil
		}
	}
}

// NativeHistory is local-only; raw tool output is never an ExecutionReport.
func (c *Client) NativeHistory(cursor string) (json.RawMessage, string, error) {
	st, err := c.roundTrip(ipcMessage{Type: "native_history", Payload: cursor})
	return st.History, st.HistoryCursor, err
}
