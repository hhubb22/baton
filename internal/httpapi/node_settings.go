package httpapi

import (
	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
	"context"
	"errors"
	"net/http"
)

type NodeSettingsGateway interface {
	SetProjectExec(context.Context, string, string, protocol.ProjectExecRequest) (protocol.ProjectExecResult, error)
	UpdateBrowseRoots(context.Context, string, string, protocol.BrowseRootsRequest) (protocol.BrowseRootsResult, error)
	StartSubscriptionLogin(context.Context, string, string, protocol.SubscriptionLoginRequest) (protocol.SubscriptionLoginResult, error)
}

func (s *Server) getEnrollment(w http.ResponseWriter, r *http.Request, id string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(id); err != nil {
		s.writeError(w, r, 400, "invalid_id", "注册标识不正确")
		return
	}
	view, err := s.store.OwnEnrollment(r.Context(), sess.Employee.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, r, 404, "not_found", "找不到注册记录")
		return
	}
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法读取注册状态")
		return
	}
	s.writeJSON(w, 200, view)
}

func (s *Server) setProjectExec(w http.ResponseWriter, r *http.Request, id string) {
	if s.rejectQuery(w, r) {
		return
	}
	sess, ok := s.allowWrite(w, r)
	if !ok {
		return
	}
	if _, err := identity.ParseUUID(id); err != nil {
		s.writeError(w, r, 400, "invalid_id", "节点标识不正确")
		return
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if !s.readJSON(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		s.writeError(w, r, 400, "invalid_request", "需要提供命令授权状态")
		return
	}
	view, err := s.store.OwnNode(r.Context(), sess.Employee.ID, id)
	if errors.Is(err, store.ErrSyncRejected) {
		s.writeError(w, r, 403, "forbidden", "不能设置该节点")
		return
	}
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法设置节点")
		return
	}
	if view.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return
	}
	if !view.Executable() {
		s.writeError(w, r, 503, "node_offline", "设备未连接或尚未同步")
		return
	}
	gateway := s.nodeSettings
	if gateway == nil {
		gateway, _ = s.files.(NodeSettingsGateway)
	}
	if gateway == nil {
		s.writeError(w, r, 503, "node_unavailable", "设备设置通道不可用")
		return
	}
	op, err := identity.NewUUID()
	if err != nil {
		s.writeError(w, r, 503, "unavailable", "暂时无法设置节点")
		return
	}
	result, err := gateway.SetProjectExec(r.Context(), sess.Employee.ID, id, protocol.ProjectExecRequest{Type: protocol.BodyProjectExecSet, OperationID: op, Enabled: *in.Enabled})
	if err != nil || result.OperationID != op || !result.OK || result.Exec == nil || result.Exec.Enabled != *in.Enabled {
		s.writeError(w, r, 503, "node_unavailable", "设备尚未确认保存配置，请重新读取设备状态")
		return
	}
	// 响应前再次检查吊销；配置事实由节点报告同步。
	view, err = s.store.OwnNode(r.Context(), sess.Employee.ID, id)
	if err != nil || view.Revoked {
		s.writeError(w, r, 403, "revoked", "该节点已吊销")
		return
	}
	out := nodeStatusFrom(view)
	if out.RuntimeReport != nil {
		report := *out.RuntimeReport
		report.Exec = *result.Exec
		out.RuntimeReport = &report
	}
	s.writeJSON(w, 200, out)
}
