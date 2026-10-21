package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/codex"
	"baton/internal/agent/kiro"
	"baton/internal/agent/pi"
	"baton/internal/protocol"
)

func historyResult(req protocol.SessionRequest, page protocol.SessionHistoryPage, err error) protocol.SessionResult {
	result := protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID}
	if err == nil && protocol.ValidHistoryPage(&page) {
		result.OK, result.History = true, &page
		return result
	}
	result.Code = "history_unavailable"
	switch {
	case errors.Is(err, agent.ErrInvalidCursor):
		result.Code = "invalid_cursor"
	case errors.Is(err, agent.ErrHistoryChanged):
		result.Code = "history_changed"
	case errors.Is(err, agent.ErrHistoryMissing), errors.Is(err, ErrHistoryMissing):
		result.Code = "history_missing"
	}
	return result
}

func (w *workerDB) browserHistory(req protocol.SessionRequest) protocol.SessionResult {
	w.mu.Lock()
	adapter, ok := w.adapter.(agent.BrowserHistoryAdapter)
	w.mu.Unlock()
	if !ok {
		return historyResult(req, protocol.SessionHistoryPage{}, agent.ErrHistoryUnread)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	page, err := adapter.ReadBrowserHistory(ctx, req.Cursor, req.Limit)
	return historyResult(req, page, err)
}

// storedHistory 只读既有配置和历史，查询不依赖 Worker 的存活状态。
func (h *Host) storedHistory(ctx context.Context, req protocol.SessionRequest) (protocol.SessionResult, bool) {
	fail := func(err error) (protocol.SessionResult, bool) {
		return historyResult(req, protocol.SessionHistoryPage{}, err), true
	}
	path, err := LedgerPath(h.DataDir, req.SessionID)
	if err != nil {
		return fail(err)
	}
	threadPath, err := ThreadLedgerPath(h.DataDir, req.SessionID)
	if err != nil {
		return fail(err)
	}
	thread := false
	if _, err := os.Stat(threadPath); err == nil {
		path, thread = threadPath, true
	} else if !os.IsNotExist(err) {
		return fail(err)
	}
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return fail(ErrHistoryMissing)
		}
		return fail(err)
	}
	db, err := sql.Open("sqlite", sqliteDSN(path)+"&mode=ro")
	if err != nil {
		return fail(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var raw, kind string
	kindQuery, configQuery := `SELECT value FROM meta WHERE key='agent_type'`, `SELECT value FROM meta WHERE key='adapter_config'`
	if thread {
		kindQuery, configQuery = `SELECT agent_type FROM thread_meta`, `SELECT adapter_config FROM thread_meta`
	}
	if err := db.QueryRowContext(ctx, kindQuery).Scan(&kind); err != nil {
		return fail(err)
	}
	if kind != "pi" && kind != "codex" && kind != "kiro" {
		return protocol.SessionResult{}, false
	}
	if err := db.QueryRowContext(ctx, configQuery).Scan(&raw); err != nil {
		return fail(err)
	}
	var config agent.Config
	if json.Unmarshal([]byte(raw), &config) != nil || config.SessionID != req.SessionID {
		return fail(agent.ErrHistoryMissing)
	}
	var adapter agent.BrowserHistoryAdapter
	if kind == "pi" {
		adapter = pi.New(config)
	} else if kind == "kiro" {
		c := kiro.New(config)
		defer c.Close()
		adapter = c
	} else {
		c := codex.New(config)
		defer c.Close()
		adapter = c
	}
	page, err := adapter.ReadBrowserHistory(ctx, req.Cursor, req.Limit)
	return historyResult(req, page, err), true
}
