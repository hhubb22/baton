package httpapi

import (
	"net/http"

	"baton/internal/identity"
	"baton/internal/task"
)

func (s *Server) taskAcceptance(w http.ResponseWriter, r *http.Request, id string) {
	if s.rejectQuery(w, r) {
		return
	}
	if _, err := identity.ParseUUID(id); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "任务标识不正确")
		return
	}
	switch r.Method {
	case http.MethodPost:
		sess, ok := s.allowWrite(w, r)
		if !ok {
			return
		}
		var in task.AcceptanceInput
		if !s.readJSON(w, r, &in) {
			return
		}
		rec, err := s.store.AcceptResult(r.Context(), sess.Employee.ID, id, in)
		if err != nil {
			s.writeTaskError(w, r, sess.Employee.ID, err)
			return
		}
		s.writeJSON(w, http.StatusOK, rec)
	case http.MethodGet:
		sess, ok := s.requireSession(w, r)
		if !ok {
			return
		}
		recs, err := s.store.ListAcceptances(r.Context(), sess.Employee.ID, id)
		if err != nil {
			s.writeTaskError(w, r, sess.Employee.ID, err)
			return
		}
		s.writeJSON(w, http.StatusOK, struct {
			Acceptances []task.Acceptance `json:"acceptances"`
		}{recs})
	default:
		s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
	}
}
