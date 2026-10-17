package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"baton/internal/identity"
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
