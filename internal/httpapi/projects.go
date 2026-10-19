package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"baton/internal/identity"
	"baton/internal/projectagent"
	"baton/internal/store"
)

// 请求上限包含 64 KiB 正文的 JSON 转义和字段元数据；正文单独按 UTF-8 字节限长。
const maxProjectJSONBytes = 512 << 10

func (s *Server) routeProject(w http.ResponseWriter, r *http.Request) {
	parts := []string{}
	if r.URL.Path != "/api/v1/projects" {
		parts = strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/projects/"), "/")
	}
	allowed := false
	switch {
	case len(parts) == 0:
		allowed = r.Method == http.MethodGet || r.Method == http.MethodPost
	case len(parts) == 1:
		allowed = r.Method == http.MethodGet || r.Method == http.MethodPatch
	case len(parts) == 2 && parts[1] == "messages":
		allowed = r.Method == http.MethodPost
	case len(parts) == 2 && (parts[1] == "events" || parts[1] == "memory"):
		allowed = r.Method == http.MethodGet
	case len(parts) == 3 && parts[1] == "memory":
		allowed = r.Method == http.MethodPut || r.Method == http.MethodGet
	default:
		s.writeError(w, r, 404, "not_found", "找不到对应接口")
		return
	}
	if !allowed {
		s.writeError(w, r, 405, "method_not_allowed", "不支持该请求方法")
		return
	}
	var sess store.Session
	var ok bool
	if r.Method == http.MethodGet {
		sess, ok = s.requireSession(w, r)
	} else {
		if s.rejectQuery(w, r) {
			return
		}
		sess, ok = s.allowWrite(w, r)
	}
	if !ok {
		return
	}
	if len(parts) > 0 {
		id, err := identity.ParseUUID(parts[0])
		if err != nil {
			s.writeError(w, r, 400, "invalid_id", "Project 标识不正确")
			return
		}
		parts[0] = id
	}
	if len(parts) == 3 {
		id, err := identity.ParseUUID(parts[2])
		if err != nil {
			s.writeError(w, r, 400, "invalid_id", "记忆标识不正确")
			return
		}
		parts[2] = id
	}
	employeeID := sess.Employee.ID
	switch {
	case len(parts) == 0 && r.Method == http.MethodPost:
		var in projectagent.CreateInput
		if !s.readJSONLimit(w, r, &in, maxProjectJSONBytes) {
			return
		}
		p, err := s.store.CreateProject(r.Context(), employeeID, in)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 201, p)
	case len(parts) == 0:
		after, limit, ok := s.projectListQuery(w, r)
		if !ok {
			return
		}
		items, err := s.store.ListProjects(r.Context(), employeeID, after, limit)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		next := ""
		if len(items) == limit {
			next = items[len(items)-1].ID
		}
		s.writeJSON(w, 200, struct {
			Projects    []projectagent.Project `json:"projects"`
			NextAfterID string                 `json:"next_after_id,omitempty"`
		}{items, next})
	case len(parts) == 1 && r.Method == http.MethodPatch:
		var in projectagent.Patch
		if !s.readJSONLimit(w, r, &in, maxProjectJSONBytes) {
			return
		}
		if in.Title == nil && in.Goal == nil && in.Status == nil && in.Provider == nil && in.Model == nil {
			s.writeProjectError(w, r, projectagent.ErrInvalid)
			return
		}
		p, err := s.store.PatchProject(r.Context(), employeeID, parts[0], in)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 200, p)
	case len(parts) == 1:
		if s.rejectQuery(w, r) {
			return
		}
		p, err := s.store.Project(r.Context(), employeeID, parts[0])
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 200, p)
	case parts[1] == "messages":
		var in projectagent.MessageInput
		if !s.readJSONLimit(w, r, &in, maxProjectJSONBytes) {
			return
		}
		msg, err := s.store.AcceptProjectMessage(r.Context(), employeeID, parts[0], in)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 202, msg)
	case parts[1] == "events":
		q, ok := s.projectQuery(w, r, "after_seq", "limit")
		if !ok {
			return
		}
		after, err := projectQueryInt(q, "after_seq", 0, 0, 1<<63-1)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		limit, err := projectQueryInt(q, "limit", 50, 1, 100)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		page, err := s.store.ProjectEvents(r.Context(), employeeID, parts[0], after, int(limit))
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 200, page)
	case len(parts) == 2:
		after, limit, ok := s.projectListQuery(w, r)
		if !ok {
			return
		}
		items, err := s.store.ListProjectMemory(r.Context(), employeeID, parts[0], after, limit)
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		next := ""
		if len(items) == limit {
			next = items[len(items)-1].ID
		}
		s.writeJSON(w, 200, struct {
			Entries     []projectagent.Memory `json:"entries"`
			NextAfterID string                `json:"next_after_id,omitempty"`
		}{items, next})
	case r.Method == http.MethodGet:
		if s.rejectQuery(w, r) {
			return
		}
		item, err := s.store.ProjectMemory(r.Context(), employeeID, parts[0], parts[2])
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 200, item)
	default:
		var in struct {
			Title            string `json:"title"`
			Content          string `json:"content"`
			ExpectedRevision *int64 `json:"expected_revision"`
		}
		if !s.readJSONLimit(w, r, &in, maxProjectJSONBytes) {
			return
		}
		if in.ExpectedRevision == nil {
			s.writeProjectError(w, r, projectagent.ErrInvalid)
			return
		}
		item, err := s.store.WriteProjectMemory(r.Context(), employeeID, parts[0], parts[2], projectagent.MemoryWrite{
			Title: in.Title, Content: in.Content, ExpectedRevision: *in.ExpectedRevision, Author: "user",
		})
		if err != nil {
			s.writeProjectError(w, r, err)
			return
		}
		s.writeJSON(w, 200, item)
	}
}

func (s *Server) projectQuery(w http.ResponseWriter, r *http.Request, keys ...string) (url.Values, bool) {
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		s.writeProjectError(w, r, projectagent.ErrInvalid)
		return nil, false
	}
	for key, values := range q {
		allowed := false
		for _, known := range keys {
			if key == known {
				allowed = true
			}
		}
		if !allowed || len(values) != 1 || values[0] == "" {
			s.writeProjectError(w, r, projectagent.ErrInvalid)
			return nil, false
		}
	}
	return q, true
}

func (s *Server) projectListQuery(w http.ResponseWriter, r *http.Request) (string, int, bool) {
	q, ok := s.projectQuery(w, r, "after_id", "limit")
	if !ok {
		return "", 0, false
	}
	after := q.Get("after_id")
	if after != "" {
		var err error
		after, err = identity.ParseUUID(after)
		if err != nil {
			s.writeProjectError(w, r, projectagent.ErrInvalid)
			return "", 0, false
		}
	}
	limit, err := projectQueryInt(q, "limit", 50, 1, 100)
	if err != nil {
		s.writeProjectError(w, r, err)
		return "", 0, false
	}
	return after, int(limit), true
}

func projectQueryInt(q url.Values, key string, fallback, min, max int64) (int64, error) {
	if q.Get(key) == "" {
		return fallback, nil
	}
	v, err := strconv.ParseInt(q.Get(key), 10, 64)
	if err != nil || v < min || v > max {
		return 0, projectagent.ErrInvalid
	}
	return v, nil
}

func (s *Server) writeProjectError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *projectagent.MemoryConflict
	switch {
	case errors.Is(err, store.ErrNotFound):
		s.writeError(w, r, 404, "not_found", "找不到对应记录")
	case errors.Is(err, projectagent.ErrInvalid):
		s.writeError(w, r, 400, "invalid_request", "请求参数不正确")
	case errors.Is(err, projectagent.ErrTooLarge):
		s.writeError(w, r, 413, "body_too_large", "正文超过 64 KiB 或编码后的消息超过队列容量")
	case errors.Is(err, projectagent.ErrMessageConflict):
		s.writeError(w, r, 409, "message_conflict", "消息标识已用于不同内容")
	case errors.As(err, &conflict):
		var revision int64
		if conflict.Current != nil {
			revision = conflict.Current.Revision
		}
		s.writeJSON(w, 409, struct {
			Code            string               `json:"code"`
			Message         string               `json:"message"`
			RequestID       string               `json:"request_id"`
			CurrentRevision int64                `json:"current_revision"`
			Current         *projectagent.Memory `json:"current"`
		}{"revision_conflict", conflict.Error(), requestID(r.Context()), revision, conflict.Current})
	default:
		s.log.Error("Project 请求失败", "request_id", requestID(r.Context()))
		s.writeError(w, r, 500, "unavailable", "暂时无法处理请求")
	}
}
