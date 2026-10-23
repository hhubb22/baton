package httpapi

import (
	"baton/internal/auth"
	"baton/internal/identity"
	"baton/internal/protocol"
	"net/http"
	"strconv"
)

func (s *Server) threadRead(w http.ResponseWriter, r *http.Request, id, action string) {
	login, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if login.Employee.MustChangePassword {
		s.writeError(w, r, 403, "password_change_required", "请先更换初始口令")
		return
	}
	key := "cursor"
	if action == "trace" {
		key = "worker_turn_seq"
	}
	q, ok := s.projectQuery(w, r, key)
	if !ok {
		return
	}
	item, err := s.store.GetThread(r.Context(), login.Employee.ID, id)
	if err != nil {
		s.writeThreadError(w, r, err)
		return
	}
	if action == "trace" {
		seq, err := strconv.ParseInt(q.Get(key), 10, 64)
		if err != nil || seq < 1 {
			s.writeError(w, r, 400, "invalid_request", "需要指定执行轮次")
			return
		}
		trace, err := s.store.ThreadTrace(r.Context(), login.Employee.ID, id, seq)
		if err != nil {
			s.writeThreadError(w, r, err)
			return
		}
		s.writeJSON(w, 200, trace)
		return
	}
	cursor := q.Get("cursor")
	if len(cursor) > protocol.SessionCursorBytes {
		s.writeError(w, r, 400, "invalid_cursor", "输出游标无效")
		return
	}
	if !s.outputBudget.Reserve(protocol.SessionOutputBytes) {
		s.writeError(w, r, 503, "capacity", "输出缓存已达上限")
		return
	}
	defer s.outputBudget.Release(protocol.SessionOutputBytes)
	op, err := identity.NewUUID()
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法读取输出")
		return
	}
	result := s.sessionRPC(r.Context(), login.Employee.ID, item, protocol.SessionRequest{OperationID: op, SessionID: id, Action: "output", Cursor: cursor})
	cookie, err := r.Cookie(auth.SessionCookieName)
	if err != nil {
		s.writeError(w, r, 401, "unauthenticated", "请重新登录")
		return
	}
	if _, err := s.store.LookupSession(r.Context(), cookie.Value); err != nil {
		s.writeError(w, r, 401, "unauthenticated", "请重新登录")
		return
	}
	node, err := s.store.OwnNode(r.Context(), login.Employee.ID, item.NodeID)
	if err != nil || node.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return
	}
	if !result.OK {
		result.Text = ""
	}
	result.Text = boundedSessionText(result.Text)
	result.History = nil
	s.writeJSON(w, 200, result)
}
