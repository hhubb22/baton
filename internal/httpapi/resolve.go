package httpapi

import (
	"net/http"

	"baton/internal/identity"
	"baton/internal/task"
)

func (s *Server) manualTask(w http.ResponseWriter, r *http.Request, id, action string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(id); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "任务标识不正确")
		return
	}
	var rec task.Record
	var err error
	if action == "resolve" {
		var in task.ResolveInput
		if !s.readJSONLimit(w, r, &in, maxTaskJSONBytes) {
			return
		}
		rec, err = s.store.ResolveTask(r.Context(), sess.Employee.ID, id, in)
	} else {
		var in task.RerunInput
		if !s.readJSON(w, r, &in) {
			return
		}
		rec, err = s.store.RerunTask(r.Context(), sess.Employee.ID, id, in)
	}
	if err != nil {
		s.writeTaskError(w, r, sess.Employee.ID, err)
		return
	}
	s.log.Info("task manual action", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID,
		"task_id", id, "action", action, "result_task_id", rec.TaskID)
	s.writeJSON(w, http.StatusOK, rec)
}
