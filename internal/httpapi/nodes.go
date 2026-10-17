package httpapi

import (
	"errors"
	"net/http"
	"time"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/store"
)

func (s *Server) issueEnrollment(w http.ResponseWriter, r *http.Request) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return
	}
	var body struct{}
	if !s.readJSON(w, r, &body) {
		return
	}
	id, token, expires, err := s.store.IssueEnrollment(r.Context(), sess.Employee.ID, s.enrollmentTTL)
	if err != nil {
		s.log.Error("enrollment failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	s.log.Info("enrollment issued", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "enrollment_id", id)
	s.writeJSON(w, http.StatusOK, struct {
		EnrollmentID    string `json:"enrollment_id"`
		EnrollmentToken string `json:"enrollment_token"`
		ExpiresAt       any    `json:"expires_at"`
	}{
		EnrollmentID:    id,
		EnrollmentToken: token,
		ExpiresAt:       expires,
	})
}

func (s *Server) registerNode(w http.ResponseWriter, r *http.Request) {
	if s.rejectQuery(w, r) {
		return
	}
	var body struct {
		EnrollmentToken string    `json:"enrollment_token"`
		DisplayName     string    `json:"display_name"`
		System          string    `json:"system"`
		Role            string    `json:"role"`
		Capabilities    *[]string `json:"capabilities"`
	}
	if !s.readJSON(w, r, &body) {
		return
	}
	if body.Capabilities == nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_node", "需要提供能力列表")
		return
	}
	ident, err := s.store.Register(r.Context(), store.RegisterInput{
		Token:         body.EnrollmentToken,
		DisplayName:   body.DisplayName,
		System:        body.System,
		Role:          body.Role,
		Capabilities:  *body.Capabilities,
		CredentialTTL: s.nodeCredentialTTL,
	}, s.signer)
	if err != nil {
		s.writeRegisterError(w, r, err)
		return
	}
	s.log.Info("node registered",
		"request_id", requestID(r.Context()),
		"employee_id", ident.EmployeeID,
		"node_id", ident.NodeID,
		"role", ident.Role,
		"registration_seq", ident.RegistrationSeq,
	)
	s.writeJSON(w, http.StatusOK, ident)
}

type nodeStatusJSON struct {
	ID              string     `json:"id"`
	DisplayName     string     `json:"display_name"`
	System          string     `json:"system"`
	Role            string     `json:"role"`
	Capabilities    []string   `json:"capabilities"`
	RegistrationSeq int64      `json:"registration_seq"`
	Online          bool       `json:"online"`
	LastContact     *time.Time `json:"last_contact_at"`
	StatusUpdated   *time.Time `json:"status_updated_at"`
	Synced          bool       `json:"synced"`
	Executable      bool       `json:"executable"`
}

func nodeStatusFrom(view store.NodeView) nodeStatusJSON {
	return nodeStatusJSON{
		ID:              view.ID,
		DisplayName:     view.DisplayName,
		System:          view.System,
		Role:            view.Role,
		Capabilities:    view.Capabilities,
		RegistrationSeq: view.RegistrationSeq,
		Online:          view.Online,
		LastContact:     view.LastContact,
		StatusUpdated:   view.StatusUpdated,
		Synced:          view.Synced,
		Executable:      view.Executable(),
	}
}

func (s *Server) listNodes(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	views, err := s.store.ListNodes(r.Context(), sess.Employee.ID)
	if err != nil {
		s.log.Error("list nodes failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	out := make([]nodeStatusJSON, 0, len(views))
	for _, view := range views {
		out = append(out, nodeStatusFrom(view))
	}
	s.writeJSON(w, http.StatusOK, struct {
		Nodes []nodeStatusJSON `json:"nodes"`
	}{Nodes: out})
}

func (s *Server) getNode(w http.ResponseWriter, r *http.Request, rawID string) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "节点标识不正确")
		return
	}
	view, err := s.store.OwnNode(r.Context(), sess.Employee.ID, rawID)
	if errors.Is(err, store.ErrSyncRejected) {
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能查看该节点")
		return
	}
	if err != nil {
		s.log.Error("get node failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	s.writeJSON(w, http.StatusOK, nodeStatusFrom(view))
}

func (s *Server) putDefaultPC(w http.ResponseWriter, r *http.Request) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return
	}
	var body struct {
		NodeID string `json:"node_id"`
	}
	if !s.readJSON(w, r, &body) {
		return
	}
	saved, err := s.store.SetDefaultPC(r.Context(), sess.Employee.ID, body.NodeID)
	if errors.Is(err, store.ErrDefaultRejected) {
		s.log.Info("default pc rejected", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "code", "forbidden")
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能将该节点设为默认 PC")
		return
	}
	if errors.Is(err, store.ErrNotPCNode) {
		s.writeError(w, r, http.StatusBadRequest, "invalid_node", "只能选择本人的 PC 执行节点")
		return
	}
	if errors.Is(err, store.ErrNodeInactive) {
		s.writeError(w, r, http.StatusBadRequest, "invalid_node", "该节点已不能作为默认 PC")
		return
	}
	if err != nil {
		s.log.Error("default pc failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	s.log.Info("default pc updated", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", saved.NodeID)
	s.writeJSON(w, http.StatusOK, saved)
}

func (s *Server) writeRegisterError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrEnrollmentExpired):
		s.log.Info("node register rejected", "request_id", requestID(r.Context()), "code", "enrollment_expired")
		s.writeError(w, r, http.StatusUnauthorized, "enrollment_expired", "注册凭据已过期")
	case errors.Is(err, store.ErrEnrollmentUsed):
		s.log.Info("node register rejected", "request_id", requestID(r.Context()), "code", "enrollment_used")
		s.writeError(w, r, http.StatusUnauthorized, "enrollment_used", "注册凭据已使用")
	case errors.Is(err, store.ErrEnrollmentInvalid):
		s.log.Info("node register rejected", "request_id", requestID(r.Context()), "code", "invalid_enrollment")
		s.writeError(w, r, http.StatusUnauthorized, "invalid_enrollment", "注册凭据无效")
	default:
		var invalid *node.ValidationError
		if errors.As(err, &invalid) {
			s.writeError(w, r, http.StatusBadRequest, "invalid_node", invalid.Error())
			return
		}
		s.log.Error("node register failed", "request_id", requestID(r.Context()))
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
	}
}

func (s *Server) allowWrite(w http.ResponseWriter, r *http.Request) (store.Session, bool) {
	if !s.allowOrigin(w, r) {
		return store.Session{}, false
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return store.Session{}, false
	}
	if !s.allowCSRF(w, r, sess.CSRFHash) {
		return store.Session{}, false
	}
	return sess, true
}

func (s *Server) rejectQuery(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery != "" {
		s.writeError(w, r, http.StatusBadRequest, "invalid_request", "请求不能在 URL 中携带参数")
		return true
	}
	return false
}
