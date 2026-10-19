package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"baton/internal/identity"
	"baton/internal/inbox"
	"baton/internal/store"
)

func (s *Server) routeInbox(w http.ResponseWriter, r *http.Request) {
	list := r.URL.Path == "/api/v1/inbox"
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/attention-requests/"), "/")
	close := !list && len(parts) == 2 && parts[1] == "close"
	write := !list && len(parts) == 2 && (close || parts[1] == "answer")
	if !list && len(parts) != 1 && !write {
		s.writeError(w, r, 404, "not_found", "找不到对应接口")
		return
	}
	if (write && r.Method != http.MethodPost) || (!write && r.Method != http.MethodGet) {
		s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
		return
	}
	var sess store.Session
	var ok bool
	if write {
		if s.rejectQuery(w, r) {
			return
		}
		sess, ok = s.allowWrite(w, r)
	} else {
		sess, ok = s.requireSession(w, r)
	}
	if !ok {
		return
	}
	if list {
		q := r.URL.Query()
		var err error
		for key, values := range q {
			if (key != "state" && key != "cursor") || len(values) != 1 {
				err = inbox.ErrInvalid
			}
		}
		if err != nil {
			s.writeInboxError(w, r, err)
			return
		}
		out, err := s.store.Inbox(r.Context(), sess.Employee.ID, q.Get("state"), q.Get("cursor"))
		if err != nil {
			s.writeInboxError(w, r, err)
			return
		}
		s.writeJSON(w, 200, out)
		return
	}
	id, err := identity.ParseUUID(parts[0])
	if err != nil {
		s.writeInboxError(w, r, inbox.ErrInvalid)
		return
	}
	if !write {
		if s.rejectQuery(w, r) {
			return
		}
		out, err := s.store.AttentionRequest(r.Context(), sess.Employee.ID, id)
		if err != nil {
			s.writeInboxError(w, r, err)
			return
		}
		s.writeJSON(w, 200, out)
		return
	}
	var h inbox.Handle
	if !s.readJSON(w, r, &h) {
		return
	}
	out, err := s.store.HandleAttentionRequest(r.Context(), sess.Employee.ID, id, h, close)
	if err != nil {
		s.writeInboxError(w, r, err)
		return
	}
	s.writeJSON(w, 200, out)
}
func (s *Server) writeInboxError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *inbox.Conflict
	switch {
	case errors.As(err, &conflict):
		s.writeJSON(w, 409, struct {
			Error   string        `json:"error"`
			Current inbox.Request `json:"current"`
		}{"conflict", conflict.Current})
	case errors.Is(err, inbox.ErrNotFound):
		s.writeError(w, r, 404, "not_found", "事项不存在")
	case errors.Is(err, inbox.ErrInvalid):
		s.writeError(w, r, 400, "invalid_request", "事项参数无效")
	default:
		s.writeProjectError(w, r, err)
	}
}
