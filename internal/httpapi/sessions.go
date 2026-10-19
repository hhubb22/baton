package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
)

func (s *Server) routeSession(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/v1/sessions" {
		if r.Method != http.MethodGet {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.listSessions(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/sessions/")
	parts := strings.Split(rest, "/")
	if len(parts) == 2 && parts[1] == "history" {
		s.sessionHistory(w, r, parts[0])
		return
	}
	if len(parts) == 2 && (parts[1] == "input" || parts[1] == "resume") {
		s.sessionAction(w, r, parts[0], parts[1])
		return
	}
	if rest == "" || strings.Contains(rest, "/") {
		s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
		return
	}
	if r.Method != http.MethodGet {
		s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
		return
	}
	s.getSession(w, r, rest)
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	items, err := s.store.ListSessions(r.Context(), sess.Employee.ID)
	if err != nil {
		s.writeSessionError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, struct {
		Sessions []store.WorkSession `json:"sessions"`
	}{Sessions: items})
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request, rawID string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "Session 标识不正确")
		return
	}
	item, err := s.store.GetSession(r.Context(), sess.Employee.ID, rawID)
	if err != nil {
		s.writeSessionError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) writeSessionError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotVisible) {
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能查看该 Session")
		return
	}
	s.log.Error("session failed", "request_id", requestID(r.Context()))
	s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
}

func (s *Server) sessionAction(w http.ResponseWriter, r *http.Request, id, action string) {
	if r.Method != http.MethodPost && !(action == "input" && r.Method == http.MethodGet) {
		s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
		return
	}
	var login store.Session
	var ok bool
	if r.Method == http.MethodPost {
		login, ok = s.allowWrite(w, r)
	} else {
		login, ok = s.requireSession(w, r)
	}
	if !ok {
		return
	}
	item, err := s.store.GetSession(r.Context(), login.Employee.ID, id)
	if err != nil {
		s.writeSessionError(w, r, err)
		return
	}
	req := protocol.SessionRequest{SessionID: id, Action: action}
	if r.Method == http.MethodGet {
		if len(r.URL.Query()) != 1 || len(r.URL.Query()["operation_id"]) != 1 {
			s.writeError(w, r, 400, "invalid_request", "需要操作标识")
			return
		}
		req.OperationID = r.URL.Query().Get("operation_id")
		req.Action = "input_status"
	} else {
		if s.rejectQuery(w, r) {
			return
		}
		var body struct {
			OperationID string `json:"operation_id"`
			Text        string `json:"text"`
		}
		if !s.readJSON(w, r, &body) {
			return
		}
		req.OperationID, req.Text = body.OperationID, body.Text
	}
	if _, err := identity.ParseUUID(req.OperationID); err != nil || len(req.Text) > 16*1024 || (req.Action == "input" && req.Text == "") {
		s.writeError(w, r, 400, "invalid_request", "操作标识或输入不正确")
		return
	}
	result := s.sessionRPC(r.Context(), login.Employee.ID, item, req)
	if action == "resume" && result.OK && result.State == "idle" {
		if err := s.store.MarkSessionResumed(r.Context(), login.Employee.ID, id); err != nil {
			s.writeSessionError(w, r, err)
			return
		}
	}
	s.writeJSON(w, http.StatusOK, result)
}
