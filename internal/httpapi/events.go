package httpapi

import (
	"baton/internal/agent"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"baton/internal/auth"
	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/coder/websocket"
)

// SessionGateway 是节点 Session 的临时通道；正文不进入中心持久化记录。
type SessionGateway interface {
	SessionRequest(context.Context, string, string, protocol.SessionRequest) (protocol.SessionResult, error)
}

type browserSubscription struct {
	SessionID string `json:"session_id"`
	Cursor    string `json:"cursor,omitempty"`
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
		return
	}
	if s.rejectQuery(w, r) || !s.allowOrigin(w, r) {
		return
	}
	parsed, parseErr := url.Parse(r.Header.Get("Origin"))
	if parseErr != nil || !strings.EqualFold(parsed.Host, r.Host) {
		s.writeError(w, r, 403, "origin_rejected", "实时通道要求同源请求")
		return
	}
	login, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if login.Employee.MustChangePassword {
		s.writeError(w, r, 403, "password_change_required", "请先更换初始口令")
		return
	}
	select {
	case s.browserSlots <- struct{}{}:
		defer func() { <-s.browserSlots }()
	default:
		s.writeError(w, r, 503, "capacity", "实时连接已达上限")
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var mu sync.Mutex
	var sub browserSubscription
	go func() {
		defer cancel()
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var next browserSubscription
			if json.Unmarshal(raw, &next) != nil || len(next.Cursor) > 100 {
				return
			}
			if next.SessionID != "" {
				if _, err := identity.ParseUUID(next.SessionID); err != nil {
					return
				}
			}
			mu.Lock()
			sub = next
			mu.Unlock()
		}
	}()
	write := func(v any) bool {
		if !s.outputBudget.Reserve(128 * 1024) {
			return false
		}
		defer s.outputBudget.Release(128 * 1024)
		raw, err := json.Marshal(v)
		if err != nil || len(raw) > 128*1024 {
			return false
		}
		timed, stop := context.WithTimeout(ctx, 2*time.Second)
		defer stop()
		return ws.Write(timed, websocket.MessageText, raw) == nil
	}
	if !write(map[string]string{"type": "ready"}) {
		return
	}
	ticker := time.NewTicker(s.eventInterval)
	defer ticker.Stop()
	var lastSessions, lastTasks string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		// 长连接持续核实 Cookie，退出、改密与到期会终止既有订阅。
		cookie, err := r.Cookie(auth.SessionCookieName)
		if err != nil {
			return
		}
		current, err := s.store.LookupSession(ctx, cookie.Value)
		if err != nil || current.Employee.ID != login.Employee.ID {
			_ = ws.Close(websocket.StatusPolicyViolation, "登录已失效")
			return
		}
		sessionStamp, taskStamp, err := s.store.NotificationStamps(ctx, login.Employee.ID)
		if err != nil {
			return
		}
		if sessionStamp != lastSessions {
			if !write(map[string]string{"type": "session.changed"}) {
				return
			}
			lastSessions = sessionStamp
		}
		if taskStamp != lastTasks {
			if !write(map[string]string{"type": "task.changed"}) {
				return
			}
			lastTasks = taskStamp
		}
		mu.Lock()
		selected := sub
		mu.Unlock()
		if selected.SessionID == "" {
			continue
		}
		item, err := s.store.GetSession(ctx, login.Employee.ID, selected.SessionID)
		if err != nil {
			_ = ws.Close(websocket.StatusPolicyViolation, "不能查看该 Session")
			return
		}
		operation, _ := identity.NewUUID()
		if !func() bool {
			if !s.outputBudget.Reserve(protocol.SessionOutputBytes) {
				return false
			}
			defer s.outputBudget.Release(protocol.SessionOutputBytes)

			result := s.sessionRPC(ctx, login.Employee.ID, item, protocol.SessionRequest{OperationID: operation, SessionID: item.SessionID, Action: "output", Cursor: selected.Cursor})
			cookie, err = r.Cookie(auth.SessionCookieName)
			if err != nil {
				return false
			}
			if _, err := s.store.LookupSession(ctx, cookie.Value); err != nil {
				return false
			}
			result.Text = boundedSessionText(result.Text)
			if !write(struct {
				Type string `json:"type"`
				protocol.SessionResult
			}{Type: "session.output", SessionResult: result}) {
				return false
			}
			mu.Lock()
			if sub == selected && result.OK {
				sub.Cursor = result.Cursor
			}
			mu.Unlock()
			return true
		}() {
			return
		}
	}
}

func boundedSessionText(text string) string {
	if len(text) > protocol.SessionOutputBytes {
		text = text[:protocol.SessionOutputBytes]
	}
	return agent.PlainText(text)
}

func (s *Server) sessionRPC(ctx context.Context, employeeID string, item store.WorkSession, req protocol.SessionRequest) protocol.SessionResult {
	fail := protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: item.SessionID, Code: "node_unavailable"}
	node, err := s.store.OwnNode(ctx, employeeID, item.NodeID)
	if err != nil || node.Revoked {
		fail.Code = "revoked"
		return fail
	}
	if !node.Online {
		fail.Code = "node_offline"
		return fail
	}
	if s.sessions == nil {
		return fail
	}
	req.Type = protocol.BodySessionRequest
	result, err := s.sessions.SessionRequest(ctx, employeeID, item.NodeID, req)
	if err != nil || result.SessionID != item.SessionID || result.OperationID != req.OperationID {
		return fail
	}
	if item.Status == "waiting_input" && result.State == "running" {
		result.State = "waiting_input"
	}
	if len(result.Text) > protocol.SessionOutputBytes {
		result.Text = boundedSessionText(result.Text)
		result.Gap = true
	}
	return result
}
