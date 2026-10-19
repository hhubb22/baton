package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"baton/internal/identity"
	"baton/internal/store"
	"baton/internal/task"
)

// SetTaskCommitHookForTest 让测试在任务事务提交前失败或观察未提交的写入。
func (s *Server) SetTaskCommitHookForTest(fn func(context.Context) error) {
	s.store.SetTaskCommitHook(fn)
}

func (s *Server) routeTask(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/tasks/")
	if rest == "" {
		s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
		return
	}
	if strings.HasSuffix(rest, "/acceptance") {
		id := strings.TrimSuffix(rest, "/acceptance")
		if id == "" || strings.Contains(id, "/") {
			s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
			return
		}
		s.taskAcceptance(w, r, id)
		return
	}
	for _, action := range []string{"resolve", "rerun"} {
		if strings.HasSuffix(rest, "/"+action) {
			id := strings.TrimSuffix(rest, "/"+action)
			if id == "" || strings.Contains(id, "/") {
				s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
				return
			}
			if r.Method != http.MethodPost {
				s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
				return
			}
			s.manualTask(w, r, id, action)
			return
		}
	}
	if strings.HasSuffix(rest, "/cancel") {
		id := strings.TrimSuffix(rest, "/cancel")
		if id == "" || strings.Contains(id, "/") {
			s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
			return
		}
		if r.Method != http.MethodPost {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.cancelTask(w, r, id)
		return
	}
	if strings.HasSuffix(rest, "/events") {
		id := strings.TrimSuffix(rest, "/events")
		if id == "" || strings.Contains(id, "/") {
			s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
			return
		}
		if r.Method != http.MethodGet {
			s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
			return
		}
		s.listTaskEvents(w, r, id)
		return
	}
	if strings.Contains(rest, "/") {
		s.writeError(w, r, http.StatusNotFound, "not_found", "找不到对应接口")
		return
	}
	if r.Method != http.MethodGet {
		s.writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "不支持该请求方法")
		return
	}
	s.getTask(w, r, rest)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return
	}
	var in task.Input
	if !s.readJSONLimit(w, r, &in, maxTaskJSONBytes) {
		return
	}
	rec, err := s.store.AcceptTask(r.Context(), sess.Employee.ID, in)
	if err != nil {
		s.writeTaskError(w, r, sess.Employee.ID, err)
		return
	}
	s.log.Info("task accepted",
		"request_id", requestID(r.Context()),
		"employee_id", sess.Employee.ID,
		"task_id", rec.TaskID,
		"target_node_id", rec.TargetNodeID,
	)
	s.writeJSON(w, http.StatusOK, rec)
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	for key, values := range query {
		if (key != "project_id" && key != "include_shell" && key != "request_id" && key != "parent_task_id" && key != "cursor") || len(values) != 1 || values[0] == "" {
			s.writeError(w, r, http.StatusBadRequest, "invalid_request", "任务查询参数无效")
			return
		}
	}
	if value := query.Get("include_shell"); value != "" && value != "true" && value != "false" {
		s.writeError(w, r, http.StatusBadRequest, "invalid_request", "命令筛选值无效")
		return
	}
	if value := query.Get("request_id"); value != "" {
		if err := task.ValidateRequestID(value); err != nil {
			s.writeError(w, r, http.StatusBadRequest, "invalid_request", "请求标识无效")
			return
		}
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	page, err := s.store.ListTaskViews(r.Context(), sess.Employee.ID, store.TaskFilter{ProjectID: query.Get("project_id"), IncludeShell: query.Get("include_shell") == "true", RequestID: query.Get("request_id"), ParentTaskID: query.Get("parent_task_id"), Cursor: query.Get("cursor")})
	if err != nil {
		s.writeTaskError(w, r, sess.Employee.ID, err)
		return
	}
	s.writeJSON(w, http.StatusOK, page)
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request, rawID string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "任务标识不正确")
		return
	}
	rec, err := s.store.GetTaskView(r.Context(), sess.Employee.ID, rawID)
	if err != nil {
		s.writeTaskError(w, r, sess.Employee.ID, err)
		return
	}
	s.writeJSON(w, http.StatusOK, rec)
}

func (s *Server) cancelTask(w http.ResponseWriter, r *http.Request, rawID string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "任务标识不正确")
		return
	}
	var body struct{}
	if !s.readJSON(w, r, &body) {
		return
	}
	decision, err := s.store.RequestCancel(r.Context(), sess.Employee.ID, rawID)
	if err != nil {
		s.writeTaskError(w, r, sess.Employee.ID, err)
		return
	}
	s.log.Info("task cancel requested",
		"request_id", requestID(r.Context()),
		"employee_id", sess.Employee.ID,
		"task_id", decision.TaskID,
		"status", decision.Status,
		"possible_start", decision.PossibleStart,
	)
	s.writeJSON(w, http.StatusOK, struct {
		TaskID        string `json:"task_id"`
		Status        string `json:"status"`
		PossibleStart bool   `json:"possible_start"`
		Version       int    `json:"version"`
	}{
		TaskID:        decision.TaskID,
		Status:        decision.Status,
		PossibleStart: decision.PossibleStart,
		Version:       decision.Version,
	})
}

func (s *Server) listTaskEvents(w http.ResponseWriter, r *http.Request, rawID string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "任务标识不正确")
		return
	}
	events, err := s.store.ListTaskEvents(r.Context(), sess.Employee.ID, rawID)
	if err != nil {
		s.writeTaskError(w, r, sess.Employee.ID, err)
		return
	}
	s.writeJSON(w, http.StatusOK, struct {
		Events []task.Event `json:"events"`
	}{Events: events})
}

func (s *Server) writeTaskError(w http.ResponseWriter, r *http.Request, employeeID string, err error) {
	var rej *task.Rejection
	if errors.As(err, &rej) {
		s.log.Info("task rejected",
			"request_id", requestID(r.Context()),
			"employee_id", employeeID,
			"code", rej.Code,
		)
		status := http.StatusBadRequest
		switch rej.Code {
		case task.CodeForbidden:
			status = http.StatusForbidden
		case task.CodeConflict, task.CodeSessionBusy:
			status = http.StatusConflict
		}
		body := errorBody{
			CurrentVersion: rej.CurrentVersion,
			CurrentStatus:  rej.CurrentStatus,
			Code:           rej.Code,
			Message:        rej.Message,
			RequestID:      requestID(r.Context()),
			TaskID:         rej.TaskID,
		}
		if len(rej.Fields) > 0 {
			body.Details = &errorDetails{Fields: append([]string(nil), rej.Fields...)}
		}
		s.writeJSON(w, status, body)
		return
	}
	if errors.Is(err, store.ErrNotVisible) {
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能查看该任务")
		return
	}
	s.log.Error("task failed", "request_id", requestID(r.Context()), "employee_id", employeeID)
	s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
}
