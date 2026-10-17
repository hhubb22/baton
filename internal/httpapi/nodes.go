package httpapi

import (
	"context"
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

const localProcessNotice = "吊销连接凭据不会停止离线节点上的本地进程。重新接入需要新的连接凭据。"

type nodeStatusJSON struct {
	ID               string          `json:"id"`
	DisplayName      string          `json:"display_name"`
	System           string          `json:"system"`
	Role             string          `json:"role"`
	Capabilities     []string        `json:"capabilities"`
	RegistrationSeq  int64           `json:"registration_seq"`
	Online           bool            `json:"online"`
	LastContact      *time.Time      `json:"last_contact_at"`
	StatusUpdated    *time.Time      `json:"status_updated_at"`
	Synced           bool            `json:"synced"`
	Executable       bool            `json:"executable"`
	RevocationStatus string          `json:"revocation_status"`
	Revocation       *revocationJSON `json:"revocation,omitempty"`
}

type revocationJSON struct {
	Status             string     `json:"status"`
	OperatorID         string     `json:"operator_id"`
	CredentialIDs      []string   `json:"credential_ids"`
	RequestedAt        time.Time  `json:"requested_at"`
	AppliedAt          *time.Time `json:"applied_at"`
	Message            string     `json:"message"`
	LocalProcessNotice string     `json:"local_process_notice"`
}

type defaultPCJSON struct {
	NodeID           string `json:"node_id"`
	Invalid          bool   `json:"invalid"`
	NeedsReselection bool   `json:"needs_reselection"`
	Message          string `json:"message,omitempty"`
}

func nodeStatusFrom(view store.NodeView) nodeStatusJSON {
	out := nodeStatusJSON{
		ID:               view.ID,
		DisplayName:      view.DisplayName,
		System:           view.System,
		Role:             view.Role,
		Capabilities:     view.Capabilities,
		RegistrationSeq:  view.RegistrationSeq,
		Online:           view.Online,
		LastContact:      view.LastContact,
		StatusUpdated:    view.StatusUpdated,
		Synced:           view.Synced,
		Executable:       view.Executable(),
		RevocationStatus: view.RevocationStatus,
	}
	if out.RevocationStatus == "" {
		out.RevocationStatus = store.RevocationNone
	}
	if out.RevocationStatus != store.RevocationNone {
		creds := view.RevokedCredentialIDs
		if creds == nil {
			creds = []string{}
		}
		var requested time.Time
		if view.RevocationRequested != nil {
			requested = *view.RevocationRequested
		}
		out.Revocation = &revocationJSON{
			Status:             out.RevocationStatus,
			OperatorID:         view.RevokedBy,
			CredentialIDs:      creds,
			RequestedAt:        requested,
			AppliedAt:          view.RevocationApplied,
			Message:            revocationMessage(out.RevocationStatus),
			LocalProcessNotice: localProcessNotice,
		}
	}
	return out
}

func revocationMessage(status string) string {
	if status == store.RevocationEffective {
		return "吊销已生效。同一连接凭据不能再连接。"
	}
	return "吊销正在处理，尚未生效。"
}

func defaultPCFrom(state store.DefaultPCState) defaultPCJSON {
	out := defaultPCJSON{NodeID: state.NodeID}
	if state.Status != store.RevocationPending && state.Status != store.RevocationEffective {
		return out
	}
	out.Invalid = true
	out.NeedsReselection = true
	out.Message = "默认 PC 仍指向该节点，需要重新选择。系统不会自动改选其他节点。" + revocationMessage(state.Status) + localProcessNotice
	return out
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
	state, err := s.store.DefaultPCState(r.Context(), sess.Employee.ID)
	if err != nil {
		s.log.Error("list nodes failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	s.writeJSON(w, http.StatusOK, struct {
		Nodes              []nodeStatusJSON `json:"nodes"`
		DefaultPC          defaultPCJSON    `json:"default_pc"`
		LocalProcessNotice string           `json:"local_process_notice"`
	}{Nodes: out, DefaultPC: defaultPCFrom(state), LocalProcessNotice: localProcessNotice})
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

func (s *Server) revokeNode(w http.ResponseWriter, r *http.Request, rawID string) {
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
	if _, err := identity.ParseUUID(rawID); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "节点标识不正确")
		return
	}
	decision, err := s.store.RevokeNode(r.Context(), sess.Employee.ID, rawID)
	if errors.Is(err, store.ErrRevokeRejected) {
		s.log.Info("node revoke rejected", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "code", "forbidden")
		s.writeError(w, r, http.StatusForbidden, "forbidden", "不能吊销该节点")
		return
	}
	if err != nil {
		s.log.Error("node revoke failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	if decision.Status == store.RevocationPending && s.revocations != nil {
		waitCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		err = s.revocations.DispatchRevocations(waitCtx)
		cancel()
		if err != nil {
			s.log.Error("node revoke dispatch failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", decision.NodeID)
		}
		reloaded, reloadErr := s.store.NodeRevocation(r.Context(), sess.Employee.ID, decision.NodeID)
		if reloadErr == nil {
			decision = reloaded
		}
	}
	state, err := s.store.DefaultPCState(r.Context(), sess.Employee.ID)
	if err != nil {
		s.log.Error("node revoke failed", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", decision.NodeID)
		s.writeError(w, r, http.StatusInternalServerError, "unavailable", "暂时无法处理请求")
		return
	}
	if decision.CredentialIDs == nil {
		decision.CredentialIDs = []string{}
	}
	s.log.Info("node revoke", "request_id", requestID(r.Context()), "employee_id", sess.Employee.ID, "node_id", decision.NodeID, "status", decision.Status)
	s.writeJSON(w, http.StatusOK, struct {
		NodeID             string        `json:"node_id"`
		Status             string        `json:"status"`
		OperatorID         string        `json:"operator_id"`
		CredentialIDs      []string      `json:"credential_ids"`
		RequestedAt        time.Time     `json:"requested_at"`
		AppliedAt          *time.Time    `json:"applied_at"`
		Message            string        `json:"message"`
		LocalProcessNotice string        `json:"local_process_notice"`
		DefaultPC          defaultPCJSON `json:"default_pc"`
	}{
		NodeID:             decision.NodeID,
		Status:             decision.Status,
		OperatorID:         decision.OperatorID,
		CredentialIDs:      decision.CredentialIDs,
		RequestedAt:        decision.RequestedAt,
		AppliedAt:          decision.AppliedAt,
		Message:            revocationMessage(decision.Status),
		LocalProcessNotice: localProcessNotice,
		DefaultPC:          defaultPCFrom(state),
	})
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
