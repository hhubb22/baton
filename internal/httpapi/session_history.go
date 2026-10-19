package httpapi

import (
	"net/http"
	"strconv"

	"baton/internal/agent"
	"baton/internal/auth"
	"baton/internal/identity"
	"baton/internal/protocol"
)

func (s *Server) sessionHistory(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
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
	if _, err := identity.ParseUUID(id); err != nil {
		s.writeError(w, r, 400, "invalid_id", "Session 标识不正确")
		return
	}
	query, err := r.URL.Query(), r.ParseForm()
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", "历史查询参数不正确")
		return
	}
	for key, values := range query {
		if (key != "cursor" && key != "limit") || len(values) != 1 {
			s.writeError(w, r, 400, "invalid_request", "历史查询参数不正确")
			return
		}
	}
	limit := protocol.SessionHistoryItems
	if values, exists := query["limit"]; exists {
		limit, err = strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > protocol.SessionHistoryItems {
			s.writeError(w, r, 400, "invalid_request", "历史每页上限为 16 条")
			return
		}
	}
	cursor := query.Get("cursor")
	if len(cursor) > protocol.SessionCursorBytes {
		s.writeError(w, r, 400, "invalid_cursor", "历史游标无效")
		return
	}
	item, err := s.store.GetSession(r.Context(), login.Employee.ID, id)
	if err != nil {
		s.writeSessionError(w, r, err)
		return
	}
	if !s.outputBudget.Reserve(protocol.SessionOutputBytes) {
		s.writeError(w, r, 503, "capacity", "历史查询缓存已达上限")
		return
	}
	defer s.outputBudget.Release(protocol.SessionOutputBytes)
	op, err := identity.NewUUID()
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法读取历史")
		return
	}
	result := s.sessionRPC(r.Context(), login.Employee.ID, item, protocol.SessionRequest{OperationID: op, SessionID: id, Action: "history", Cursor: cursor, Limit: limit})
	// 历史查询可能等待节点，交付前再次核实登录和节点吊销。
	cookie, err := r.Cookie(auth.SessionCookieName)
	if err != nil {
		s.writeError(w, r, 401, "unauthorized", "请重新登录")
		return
	}
	if _, err := s.store.LookupSession(r.Context(), cookie.Value); err != nil {
		s.writeError(w, r, 401, "unauthorized", "请重新登录")
		return
	}
	node, err := s.store.OwnNode(r.Context(), login.Employee.ID, item.NodeID)
	if err != nil || node.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return
	}
	result.Text = ""
	if result.OK {
		if !protocol.ValidHistoryPage(result.History) || len(result.History.Entries) > limit || result.History.Cursor == "" {
			result.OK, result.Code, result.History = false, "history_unavailable", nil
		} else {
			for i := range result.History.Entries {
				e := &result.History.Entries[i]
				e.Text, e.ID, e.ParentID, e.Kind, e.Reference = agent.PlainText(e.Text), agent.PlainText(e.ID), agent.PlainText(e.ParentID), agent.PlainText(e.Kind), agent.PlainText(e.Reference)
			}
		}
	} else {
		result.History = nil
	}
	w.Header().Set("Cache-Control", "no-store")
	s.writeJSON(w, http.StatusOK, result)
}
