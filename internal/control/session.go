package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

const sessionWait = 15 * time.Second

type sessionNotice struct {
	result    protocol.SessionResult
	source    protocol.Source
	transport string
	bad       bool
}

// SessionRequest 向节点发送一次临时 Session RPC，并校验响应来源与关联标识。
// 它不写入 dispatch_outbox，失败后也不自动重发。
func (s *Server) SessionRequest(ctx context.Context, employeeID, nodeID string, req protocol.SessionRequest) (protocol.SessionResult, error) {
	if _, err := identity.ParseUUID(nodeID); err != nil {
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	}
	if _, err := identity.ParseUUID(employeeID); err != nil {
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	}
	if req.OperationID == "" {
		operationID, err := identity.NewUUID()
		if err != nil {
			return protocol.SessionResult{}, errors.New("节点暂时不可达")
		}
		req.OperationID = operationID
	}
	if req.Action == "output" || req.Action == "history" {
		if !s.budget.Reserve(protocol.SessionOutputBytes) {
			return protocol.SessionResult{}, errors.New("输出缓存已达上限")
		}
		defer s.budget.Release(protocol.SessionOutputBytes)
	}
	req.Type = protocol.BodySessionRequest

	messageID, err := identity.NewUUID()
	if err != nil {
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	}
	body, err := json.Marshal(req)
	if err != nil {
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:   protocol.Version,
		MessageID: messageID,
		Route:     protocol.Route{To: nodeID},
		Priority:  protocol.PriorityControl,
		Body:      body,
	})
	if err != nil || len(env) > protocol.MaxMessageBytes {
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	}
	wait, cancel := s.armSession(messageID)
	defer cancel()
	select {
	case <-wait:
		return protocol.SessionResult{}, errors.New("临时 Session 请求已达上限")
	default:
	}

	if err := s.send(ctx, "", protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
		s.log.Info("event=session_rpc_send_failed", "node_id", nodeID, "operation_id", req.OperationID)
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	}
	s.log.Info("event=session_rpc_sent", "node_id", nodeID, "operation_id", req.OperationID)
	timer := time.NewTimer(sessionWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	case <-timer.C:
		s.log.Info("event=session_rpc_timeout", "node_id", nodeID, "operation_id", req.OperationID)
		return protocol.SessionResult{}, errors.New("节点暂时不可达")
	case notice := <-wait:
		if notice.bad || notice.transport != "" {
			s.log.Info("event=session_rpc_transport", "node_id", nodeID, "operation_id", req.OperationID, "code", notice.transport)
			return protocol.SessionResult{}, errors.New("节点暂时不可达")
		}
		if notice.source.Kind != protocol.SourceNode || notice.source.NodeID != nodeID || notice.source.EmployeeID != employeeID {
			s.log.Info("event=session_rpc_source_rejected", "node_id", nodeID, "operation_id", req.OperationID)
			return protocol.SessionResult{}, errors.New("节点暂时不可达")
		}
		if notice.result.OperationID != req.OperationID || notice.result.SessionID != req.SessionID || notice.result.Type != protocol.BodySessionResult {
			s.log.Info("event=session_rpc_result_rejected", "node_id", nodeID, "operation_id", req.OperationID)
			return protocol.SessionResult{}, errors.New("节点暂时不可达")
		}
		if !notice.result.OK {
			notice.result.Text = ""
			notice.result.History = nil
		}
		if req.Action != "history" && notice.result.History != nil {
			return protocol.SessionResult{}, errors.New("Session 响应类型不正确")
		}
		if req.Action == "history" && notice.result.OK && !protocol.ValidHistoryPage(notice.result.History) {
			return protocol.SessionResult{}, errors.New("历史响应超限或格式不正确")
		}
		return notice.result, nil
	}
}

func (s *Server) armSession(messageID string) (<-chan sessionNotice, func()) {
	ch := make(chan sessionNotice, 1)
	s.mu.Lock()
	if s.sessionWaiters == nil {
		s.sessionWaiters = map[string]chan sessionNotice{}
	}
	if len(s.sessionWaiters) >= 128 {
		s.mu.Unlock()
		ch <- sessionNotice{bad: true}
		return ch, func() {}
	}
	s.sessionWaiters[messageID] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if s.sessionWaiters[messageID] == ch {
			delete(s.sessionWaiters, messageID)
		}
		s.mu.Unlock()
	}
}

func (s *Server) noteSessionResult(env protocol.Envelope) {
	if env.Source == nil || env.CorrelationID == "" {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	dec.DisallowUnknownFields()
	var result protocol.SessionResult
	if err := dec.Decode(&result); err != nil || result.Type != protocol.BodySessionResult {
		s.deliverSession(env.CorrelationID, sessionNotice{bad: true})
		return
	}
	if len(result.Text) > protocol.SessionOutputBytes || len(result.Cursor) > 100 || len(result.Code) > 64 || len(result.State) > 32 {
		s.deliverSession(env.CorrelationID, sessionNotice{bad: true})
		return
	}
	if result.History != nil && !protocol.ValidHistoryPage(result.History) {
		s.deliverSession(env.CorrelationID, sessionNotice{bad: true})
		return
	}
	s.deliverSession(env.CorrelationID, sessionNotice{result: result, source: *env.Source})
}

func (s *Server) noteSessionTransport(messageID, code string) {
	if messageID == "" {
		return
	}
	s.deliverSession(messageID, sessionNotice{transport: code})
}

func (s *Server) deliverSession(messageID string, notice sessionNotice) {
	s.mu.Lock()
	ch := s.sessionWaiters[messageID]
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- notice:
	default:
	}
}
