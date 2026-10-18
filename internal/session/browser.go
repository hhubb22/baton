package session

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/identity"
	"baton/internal/protocol"
)

func (w *workerDB) appendLiveLocked(text string, gap bool) {
	text = agent.PlainText(text)
	w.liveText += text
	w.liveEnd += int64(len(text))
	w.liveGap = w.liveGap || gap
	if len(w.liveText) > protocol.SessionBufferBytes {
		drop := len(w.liveText) - protocol.SessionBufferBytes
		for drop < len(w.liveText) && !utf8.RuneStart(w.liveText[drop]) {
			drop++
		}
		w.liveText = w.liveText[drop:]
		w.liveBase += int64(drop)
	}
}

func (w *workerDB) sessionRequest(sessionID string, req protocol.SessionRequest) protocol.SessionResult {
	w.mu.Lock()
	defer w.mu.Unlock()
	result := protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: sessionID, ExecutionID: w.execution}
	if req.SessionID != sessionID {
		result.Code = "invalid_request"
		return result
	}
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		result.Code = "invalid_request"
		return result
	}
	if err := w.pollAdapterLocked(sessionID); err != nil {
		result.Code = "unavailable"
		return result
	}
	_, result.InputSupported = w.adapter.(agent.InputAdapter)
	var stopped string
	_ = w.db.QueryRow(`SELECT COALESCE((SELECT value FROM meta WHERE key='agent_stopped'),'0')`).Scan(&stopped)
	result.State = "idle"
	if w.cancelled || stopped == "1" {
		result.State = "stopped"
	} else if w.recoveredUncertain || w.adapter == nil {
		result.State = "unknown"
	} else if !w.resultDelivered && !w.hasResultLocked() {
		result.State = "running"
	}
	if req.Action == "validate_directory" {
		var raw string
		err := w.db.QueryRow(`SELECT value FROM meta WHERE key='adapter_config'`).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			result.OK = true
			return result
		}
		var config agent.Config
		if err != nil || json.Unmarshal([]byte(raw), &config) != nil {
			result.Code = "invalid_directory"
			return result
		}
		expected, err := filepath.Abs(config.Directory)
		if err != nil {
			result.Code = "invalid_directory"
			return result
		}
		expected, err = filepath.EvalSymlinks(expected)
		if err != nil {
			result.Code = "invalid_directory"
			return result
		}
		actual, err := filepath.Abs(req.Text)
		if err != nil {
			result.Code = "invalid_directory"
			return result
		}
		actual, err = filepath.EvalSymlinks(actual)
		if err != nil || expected != actual {
			result.Code = "invalid_directory"
			return result
		}
		result.OK = true
		return result
	}
	if req.Action == "input" || req.Action == "input_status" {
		return w.browserInputLocked(sessionID, req, result)
	}
	if req.Action == "resume" {
		if w.adapter == nil || w.recoveredUncertain || w.deliveryUncertain {
			result.Code = "history_unavailable"
			return result
		}
		if w.hasResultLocked() && !w.resultDelivered {
			result.Code = "result_pending"
			return result
		}
		if w.resultDelivered {
			if _, err := w.db.Exec(`INSERT INTO meta(key,value) VALUES('browser_resumed','1') ON CONFLICT(key) DO UPDATE SET value='1'`); err != nil {
				result.Code = "unavailable"
				return result
			}
			result.State = "idle"
		}
		result.OK = true
		return result
	}
	if req.Action != "output" {
		result.Code = "unsupported"
		return result
	}
	if w.liveEpoch == "" {
		w.liveEpoch, _ = identity.NewUUID()
	}
	offset := w.liveBase
	if req.Cursor != "" {
		parts := strings.Split(req.Cursor, ":")
		if len(parts) != 2 {
			result.Code = "invalid_cursor"
			return result
		}
		n, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || n < 0 {
			result.Code = "invalid_cursor"
			return result
		}
		if parts[0] == w.liveEpoch && n >= w.liveBase && n <= w.liveEnd {
			offset = n
		} else {
			result.Gap = true
		}
	} else if w.liveBase > 0 {
		result.Gap = true
	}
	end := min(offset+protocol.SessionOutputBytes, w.liveEnd)
	for end > offset && end < w.liveEnd && !utf8.RuneStart(w.liveText[end-w.liveBase]) {
		end--
	}
	result.Text = w.liveText[offset-w.liveBase : end-w.liveBase]
	result.Cursor = fmt.Sprintf("%s:%d", w.liveEpoch, end)
	result.Gap = result.Gap || w.liveGap
	var resumed string
	_ = w.db.QueryRow(`SELECT COALESCE((SELECT value FROM meta WHERE key='browser_resumed'),'0')`).Scan(&resumed)
	if resumed == "1" && w.resultDelivered {
		result.State = "idle"
	}
	result.OK = true
	return result
}

func (w *workerDB) browserInputLocked(sessionID string, req protocol.SessionRequest, result protocol.SessionResult) protocol.SessionResult {
	if _, err := w.db.Exec(`CREATE TABLE IF NOT EXISTS browser_inputs (id TEXT PRIMARY KEY, digest BLOB NOT NULL, state TEXT NOT NULL)`); err != nil {
		result.Code = "unavailable"
		return result
	}
	var digest []byte
	var state string
	err := w.db.QueryRow(`SELECT digest,state FROM browser_inputs WHERE id=?`, req.OperationID).Scan(&digest, &state)
	if err == nil {
		if req.Action == "input" && fmt.Sprintf("%x", sha256.Sum256([]byte(req.Text))) != fmt.Sprintf("%x", digest) {
			result.Code = "operation_conflict"
			return result
		}
		result.OK, result.Code = state == "delivered", state
		return result
	}
	if !errors.Is(err, sql.ErrNoRows) {
		result.Code = "unavailable"
		return result
	}
	if req.Action == "input_status" {
		result.Code = "not_received"
		return result
	}
	if req.Text == "" || len(req.Text) > 16*1024 || !utf8.ValidString(req.Text) {
		result.Code = "invalid_request"
		return result
	}
	adapter, supported := w.adapter.(agent.InputAdapter)
	if !supported {
		result.Code = "unsupported"
		return result
	}
	if w.cancelled || w.resultDelivered || w.hasResultLocked() || w.recoveredUncertain || w.deliveryUncertain {
		result.Code = "session_not_active"
		return result
	}
	if reason, err := w.deadlineReasonLocked(); err != nil || reason != "" {
		result.Code = "session_not_active"
		return result
	}
	sum := sha256.Sum256([]byte(req.Text))
	if _, err := w.db.Exec(`INSERT INTO browser_inputs (id,digest,state) VALUES (?,?,'uncertain')`, req.OperationID, sum[:]); err != nil {
		result.Code = "unavailable"
		return result
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := adapter.Supplement(ctx, req.OperationID, req.Text); err != nil {
		w.recoveredUncertain = true
		w.uncertainCode = "uncertain_input"
		_, _ = w.ensureVerificationLocked(sessionID)
		result.Code = "uncertain"
		return result
	}
	if _, err := w.db.Exec(`UPDATE browser_inputs SET state='delivered' WHERE id=?`, req.OperationID); err != nil {
		result.Code = "uncertain"
		return result
	}
	if _, err := w.recordExecution(sessionID, req.Text, Output{}); err != nil {
		result.Code = "uncertain"
		return result
	}
	result.OK, result.Code = true, "delivered"
	return result
}

// BrowserRequest 仅访问已存在的 Session。显式恢复也不创建账本或提交任务输入。
func (h *Host) BrowserRequest(ctx context.Context, req protocol.SessionRequest) (protocol.SessionResult, error) {
	call := func(c *Client) (Status, error) { return c.SessionRequest(req) }
	st, err := h.call(ctx, req.SessionID, call)
	if err != nil && req.Action == "resume" {
		path, pathErr := LedgerPath(h.DataDir, req.SessionID)
		if pathErr != nil {
			return protocol.SessionResult{}, pathErr
		}
		if err := InspectLedger(path); err != nil {
			return protocol.SessionResult{}, err
		}
		if err := h.spawn(ctx, req.SessionID); err != nil {
			return protocol.SessionResult{}, err
		}
		st, err = h.call(ctx, req.SessionID, call)
	}
	if err != nil || st.SessionResult == nil {
		return protocol.SessionResult{}, errors.New("Session 暂时不可达")
	}
	return *st.SessionResult, nil
}
