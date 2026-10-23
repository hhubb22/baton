package control

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

type settingsNotice struct {
	body   json.RawMessage
	source protocol.Source
}

// SetProjectExec 等待在线设备确认保存，不自动重发超时请求。
func (s *Server) SetProjectExec(ctx context.Context, employeeID, nodeID string, req protocol.ProjectExecRequest) (protocol.ProjectExecResult, error) {
	req.Type = protocol.BodyProjectExecSet
	var result protocol.ProjectExecResult
	raw, err := s.requestNodeSettings(ctx, employeeID, nodeID, req.OperationID, req, protocol.BodyProjectExecResult, 5*time.Second)
	if err == nil {
		err = protocol.DecodeRuntimeMessage(raw, &result)
		if err == nil && result.OK && (result.Exec == nil || result.Exec.Enabled != req.Enabled) {
			err = errors.New("设备未确认命令授权")
		}
	}
	return result, err
}

func (s *Server) UpdateBrowseRoots(ctx context.Context, employeeID, nodeID string, req protocol.BrowseRootsRequest) (protocol.BrowseRootsResult, error) {
	req.Type = protocol.BodyBrowseRootsSet
	var result protocol.BrowseRootsResult
	raw, err := s.requestNodeSettings(ctx, employeeID, nodeID, req.OperationID, req, protocol.BodyBrowseRootsResult, 5*time.Second)
	if err == nil {
		err = protocol.DecodeRuntimeMessage(raw, &result)
	}
	return result, err
}

func (s *Server) StartSubscriptionLogin(ctx context.Context, employeeID, nodeID string, req protocol.SubscriptionLoginRequest) (protocol.SubscriptionLoginResult, error) {
	req.Type = protocol.BodySubscriptionLogin
	var result protocol.SubscriptionLoginResult
	raw, err := s.requestNodeSettings(ctx, employeeID, nodeID, req.OperationID, req, protocol.BodySubscriptionLoginResult, 12*time.Second)
	if err == nil {
		err = protocol.DecodeRuntimeMessage(raw, &result)
	}
	return result, err
}

func (s *Server) requestNodeSettings(ctx context.Context, employeeID, nodeID, operationID string, req any, resultType string, timeout time.Duration) (json.RawMessage, error) {
	fail := errors.New("设备未确认设置请求")
	src, err := s.store.LiveNodeSource(ctx, employeeID, nodeID)
	if err != nil {
		return nil, fail
	}
	if _, err := identity.ParseUUID(operationID); err != nil {
		return nil, fail
	}
	id, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(req)
	env, _ := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: id, Route: protocol.Route{To: nodeID}, Priority: protocol.PriorityControl, Body: body})
	ch := make(chan settingsNotice, 1)
	s.mu.Lock()
	if s.settingsWait == nil {
		s.settingsWait = map[string]chan settingsNotice{}
	}
	if len(s.settingsWait) >= 128 {
		s.mu.Unlock()
		return nil, fail
	}
	s.settingsWait[id] = ch
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.settingsWait, id); s.mu.Unlock() }()
	if err := s.send(ctx, src.ConnID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
		return nil, fail
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, fail
	case <-timer.C:
		return nil, fail
	case n := <-ch:
		var head struct {
			Type        string `json:"type"`
			OperationID string `json:"operation_id"`
		}
		if n.source != src || json.Unmarshal(n.body, &head) != nil || head.OperationID != operationID || head.Type != resultType {
			return nil, fail
		}
		if err := s.store.CheckNodeConnection(ctx, src, true, true); err != nil {
			return nil, fail
		}
		return n.body, nil
	}
}

func (s *Server) noteSettingsResult(env protocol.Envelope) {
	if env.Source == nil || env.CorrelationID == "" {
		return
	}
	s.mu.Lock()
	ch := s.settingsWait[env.CorrelationID]
	s.mu.Unlock()
	if ch != nil {
		select {
		case ch <- settingsNotice{body: env.Body, source: *env.Source}:
		default:
		}
	}
}
