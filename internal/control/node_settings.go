package control

import (
	"baton/internal/identity"
	"baton/internal/protocol"
	"context"
	"encoding/json"
	"errors"
	"time"
)

type settingsNotice struct {
	result protocol.ProjectExecResult
	source protocol.Source
}

// SetProjectExec 请求当前已同步连接原子保存授权；超时不记作成功，也不自动重发。
func (s *Server) SetProjectExec(ctx context.Context, employeeID, nodeID string, req protocol.ProjectExecRequest) (protocol.ProjectExecResult, error) {
	fail := errors.New("设备未确认命令授权")
	src, err := s.store.LiveNodeSource(ctx, employeeID, nodeID)
	if err != nil {
		return protocol.ProjectExecResult{}, fail
	}
	if _, err := identity.ParseUUID(req.OperationID); err != nil {
		return protocol.ProjectExecResult{}, fail
	}
	id, err := identity.NewUUID()
	if err != nil {
		return protocol.ProjectExecResult{}, err
	}
	req.Type = protocol.BodyProjectExecSet
	body, _ := json.Marshal(req)
	env, _ := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: id, Route: protocol.Route{To: nodeID}, Priority: protocol.PriorityControl, Body: body})
	ch := make(chan settingsNotice, 1)
	s.mu.Lock()
	if s.settingsWait == nil {
		s.settingsWait = map[string]chan settingsNotice{}
	}
	if len(s.settingsWait) >= 128 {
		s.mu.Unlock()
		return protocol.ProjectExecResult{}, fail
	}
	s.settingsWait[id] = ch
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.settingsWait, id); s.mu.Unlock() }()
	if err := s.send(ctx, src.ConnID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
		return protocol.ProjectExecResult{}, fail
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return protocol.ProjectExecResult{}, fail
	case <-timer.C:
		return protocol.ProjectExecResult{}, fail
	case n := <-ch:
		if n.source != src || n.result.OperationID != req.OperationID || n.result.Type != protocol.BodyProjectExecResult {
			return protocol.ProjectExecResult{}, fail
		}
		if err := s.store.CheckNodeConnection(ctx, src, true, true); err != nil {
			return protocol.ProjectExecResult{}, fail
		}
		if n.result.OK && (n.result.Exec == nil || n.result.Exec.Enabled != req.Enabled) {
			return protocol.ProjectExecResult{}, fail
		}
		return n.result, nil
	}
}

func (s *Server) noteSettingsResult(env protocol.Envelope) {
	if env.Source == nil || env.CorrelationID == "" {
		return
	}
	var result protocol.ProjectExecResult
	if protocol.DecodeRuntimeMessage(env.Body, &result) != nil {
		return
	}
	s.mu.Lock()
	ch := s.settingsWait[env.CorrelationID]
	s.mu.Unlock()
	if ch != nil {
		select {
		case ch <- settingsNotice{result, *env.Source}:
		default:
		}
	}
}
