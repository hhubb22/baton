package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
)

func (s *Server) writableNodeSettings(w http.ResponseWriter, r *http.Request, id string) (string, NodeSettingsGateway, bool) {
	if s.rejectQuery(w, r) {
		return "", nil, false
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return "", nil, false
	}
	if _, err := identity.ParseUUID(id); err != nil {
		s.writeError(w, r, 400, "invalid_id", "节点标识不正确")
		return "", nil, false
	}
	view, err := s.store.OwnNode(r.Context(), sess.Employee.ID, id)
	if errors.Is(err, store.ErrSyncRejected) {
		s.writeError(w, r, 403, "forbidden", "不能设置该节点")
		return "", nil, false
	}
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法设置节点")
		return "", nil, false
	}
	if view.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return "", nil, false
	}
	if !view.Executable() {
		s.writeError(w, r, 503, "node_offline", "设备未连接或尚未同步")
		return "", nil, false
	}
	gateway := s.nodeSettings
	if gateway == nil {
		gateway, _ = s.files.(NodeSettingsGateway)
	}
	if gateway == nil {
		s.writeError(w, r, 503, "node_unavailable", "设备设置通道不可用")
		return "", nil, false
	}
	return sess.Employee.ID, gateway, true
}

func (s *Server) updateBrowseRoots(w http.ResponseWriter, r *http.Request, id string) {
	employeeID, gateway, ok := s.writableNodeSettings(w, r, id)
	if !ok {
		return
	}
	var in struct {
		Path string `json:"path"`
	}
	if !s.readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Path) == "" {
		s.writeError(w, r, 400, "invalid_path", "需要提供目录路径")
		return
	}
	op, err := identity.NewUUID()
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法设置节点")
		return
	}
	action := "add"
	if r.Method == http.MethodDelete {
		action = "remove"
	}
	result, err := gateway.UpdateBrowseRoots(r.Context(), employeeID, id, protocol.BrowseRootsRequest{Type: protocol.BodyBrowseRootsSet, OperationID: op, Action: action, Path: in.Path})
	if err != nil || result.OperationID != op {
		s.writeError(w, r, 503, "node_unavailable", "设备尚未确认保存目录设置")
		return
	}
	if !result.OK {
		status := http.StatusServiceUnavailable
		switch result.Code {
		case protocol.FileCodeInvalidPath, protocol.FileCodePathEscaped, "invalid_request":
			status = http.StatusBadRequest
		case protocol.FileCodeRootForbidden:
			status = http.StatusForbidden
		}
		s.writeError(w, r, status, result.Code, result.Message)
		return
	}
	view, err := s.store.OwnNode(r.Context(), employeeID, id)
	if err != nil || view.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return
	}
	out := nodeStatusFrom(view)
	if out.RuntimeReport != nil {
		report := *out.RuntimeReport
		report.Roots, report.Repos = result.Roots, result.Repos
		if report.Roots == nil {
			report.Roots = []protocol.RuntimeRoot{}
		}
		if report.Repos == nil {
			report.Repos = []protocol.RuntimeRepo{}
		}
		out.RuntimeReport = &report
	}
	s.writeJSON(w, 200, out)
}

func (s *Server) startSubscriptionLogin(w http.ResponseWriter, r *http.Request, id string) {
	employeeID, gateway, ok := s.writableNodeSettings(w, r, id)
	if !ok {
		return
	}
	var in struct {
		Provider string `json:"provider"`
	}
	if !s.readJSON(w, r, &in) {
		return
	}
	switch strings.ToLower(strings.TrimSpace(in.Provider)) {
	case "openai-codex", "chatgpt":
		in.Provider = "openai-codex"
	case "xai":
		in.Provider = "xai"
	default:
		s.writeError(w, r, 400, "unsupported_provider", "不支持该模型订阅服务")
		return
	}
	op, err := identity.NewUUID()
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法发起订阅登录")
		return
	}
	result, err := gateway.StartSubscriptionLogin(r.Context(), employeeID, id, protocol.SubscriptionLoginRequest{Type: protocol.BodySubscriptionLogin, OperationID: op, Provider: in.Provider})
	if err != nil || result.OperationID != op || !result.OK || result.Provider != in.Provider || result.VerificationURI == "" || result.UserCode == "" || result.ExpiresInSeconds <= 0 {
		s.writeError(w, r, 503, "login_unavailable", "设备未能发起订阅登录，请检查 Runtime 安装和订阅服务")
		return
	}
	view, err := s.store.OwnNode(r.Context(), employeeID, id)
	if err != nil || view.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return
	}
	s.writeJSON(w, 200, struct {
		Provider         string `json:"provider"`
		VerificationURI  string `json:"verification_uri"`
		UserCode         string `json:"user_code"`
		ExpiresInSeconds int    `json:"expires_in_seconds"`
	}{result.Provider, result.VerificationURI, result.UserCode, result.ExpiresInSeconds})
}
