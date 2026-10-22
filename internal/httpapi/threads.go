package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"baton/internal/identity"
	"baton/internal/store"
)

func (s *Server) routeThread(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/threads")
	parts := strings.Split(strings.TrimPrefix(rest, "/"), "/")
	collection := rest == ""
	action := ""
	id := ""
	mid := ""
	if !collection {
		id = parts[0]
		if _, err := identity.ParseUUID(id); err != nil {
			s.writeError(w, r, 400, "invalid_id", "Thread 标识不正确")
			return
		}
		if len(parts) > 1 {
			action = parts[1]
		}
		if len(parts) == 4 && action == "messages" && parts[3] == "withdraw" && parts[2] != "" {
			action = "withdraw"
			mid = parts[2]
		} else if len(parts) > 2 {
			s.writeError(w, r, 404, "not_found", "找不到对应接口")
			return
		}
	}
	want := http.MethodGet
	if collection {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
			return
		}
		want = r.Method
	} else {
		switch action {
		case "", "timeline", "history":
		case "messages", "withdraw", "stop", "archive":
			want = http.MethodPost
		default:
			s.writeError(w, r, 404, "not_found", "找不到对应接口")
			return
		}
		if r.Method != want {
			s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
			return
		}
	}
	if action == "history" {
		s.threadHistory(w, r, id)
		return
	}
	var login store.Session
	var ok bool
	if want == http.MethodPost {
		login, ok = s.allowWrite(w, r)
	} else {
		login, ok = s.requireSession(w, r)
	}
	if !ok {
		return
	}
	employeeID := login.Employee.ID
	if want == http.MethodPost {
		if s.rejectQuery(w, r) {
			return
		}
		if collection {
			var body struct {
				ClientThreadID   string `json:"client_thread_id"`
				NodeID           string `json:"node_id"`
				AgentType        string `json:"agent_type"`
				Model            string `json:"model"`
				WorkingDirectory string `json:"working_directory"`
				Message          struct {
					ClientMessageID string `json:"client_message_id"`
					Content         string `json:"content"`
				} `json:"message"`
			}
			if !s.readJSONLimit(w, r, &body, 512<<10) {
				return
			}
			in := store.CreateThreadInput{ClientThreadID: body.ClientThreadID, NodeID: body.NodeID, AgentType: body.AgentType, Model: body.Model, WorkingDirectory: body.WorkingDirectory, Message: store.ThreadMessageInput{ClientMessageID: body.Message.ClientMessageID, Content: body.Message.Content}}
			t, created, err := s.store.CreateThread(r.Context(), employeeID, in)
			if err != nil {
				s.writeThreadError(w, r, err)
				return
			}
			status := http.StatusOK
			if created {
				status = http.StatusCreated
			}
			s.writeJSON(w, status, t)
			return
		}
		if action == "messages" {
			var in store.ThreadMessageInput
			if !s.readJSONLimit(w, r, &in, 512<<10) {
				return
			}
			m, err := s.store.SendThreadMessage(r.Context(), employeeID, id, in)
			if err != nil {
				s.writeThreadError(w, r, err)
				return
			}
			s.writeJSON(w, 202, m)
			return
		}
		var in struct{}
		if !s.readJSON(w, r, &in) {
			return
		}
		t, err := s.store.RequestThreadAction(r.Context(), employeeID, id, action, mid)
		if err != nil {
			s.writeThreadError(w, r, err)
			return
		}
		s.writeJSON(w, 202, t)
		return
	}
	query := r.URL.Query()
	allowed := ""
	if collection {
		allowed = " project_id node_id status cursor limit "
	} else if action == "timeline" {
		allowed = " cursor limit "
	}
	for key, values := range query {
		if len(values) != 1 || !strings.Contains(allowed, " "+key+" ") {
			s.writeThreadError(w, r, &store.ThreadError{Status: 400, Code: "invalid_request", Message: "查询参数无效"})
			return
		}
	}
	limit := 0
	if value, exists := query["limit"]; exists {
		var err error
		limit, err = strconv.Atoi(value[0])
		if err != nil || limit < 1 || limit > 100 {
			s.writeError(w, r, 400, "invalid_request", "每页上限为 100 条")
			return
		}
	}
	if collection {
		page, err := s.store.ListThreads(r.Context(), employeeID, store.ThreadFilter{ProjectID: query.Get("project_id"), NodeID: query.Get("node_id"), Status: query.Get("status"), Cursor: query.Get("cursor"), Limit: limit})
		if err != nil {
			s.writeThreadError(w, r, err)
			return
		}
		s.writeJSON(w, 200, page)
		return
	}
	if action == "timeline" {
		page, err := s.store.ThreadTimeline(r.Context(), employeeID, id, query.Get("cursor"), limit)
		if err != nil {
			s.writeThreadError(w, r, err)
			return
		}
		s.writeJSON(w, 200, page)
		return
	}
	view, err := s.store.GetThread(r.Context(), employeeID, id)
	if err != nil {
		s.writeThreadError(w, r, err)
		return
	}
	s.writeJSON(w, 200, view)
}
func (s *Server) writeThreadError(w http.ResponseWriter, r *http.Request, err error) {
	var rejection *store.ThreadError
	if errors.As(err, &rejection) {
		s.writeJSON(w, rejection.Status, struct {
			*store.ThreadError
			RequestID string `json:"request_id"`
		}{rejection, requestID(r.Context())})
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, r, 404, "not_found", "找不到该 Thread 或设备")
		return
	}
	s.log.Error("event=thread_request_failed", "request_id", requestID(r.Context()))
	s.writeError(w, r, 503, "unavailable", "暂时无法处理 Thread 请求")
}
