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

const fileBrowseWait = 5 * time.Second

type fileNotice struct {
	result    protocol.FileResult
	source    protocol.Source
	transport string
	bad       bool
}

// BrowseFiles 把一次文件浏览作为临时 RPC 发给节点，并等待这一条响应。
// 它不写入 dispatch_outbox，失败后也不自动重发。
func (s *Server) BrowseFiles(ctx context.Context, employeeID, nodeID string, req protocol.FileRequest) (protocol.FileResult, error) {
	if _, err := identity.ParseUUID(nodeID); err != nil {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	if _, err := identity.ParseUUID(employeeID); err != nil {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	if req.OperationID == "" {
		operationID, err := identity.NewUUID()
		if err != nil {
			return protocol.FileResult{}, errors.New("节点暂时不可达")
		}
		req.OperationID = operationID
	}
	req.Type = protocol.BodyFileBrowse
	s.mu.Lock()
	link := s.link
	ready := link != nil && link.ready
	s.mu.Unlock()
	if !ready || link == nil {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	messageID, err := identity.NewUUID()
	if err != nil {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	body, err := json.Marshal(req)
	if err != nil {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:   protocol.Version,
		MessageID: messageID,
		Route:     protocol.Route{To: nodeID},
		Priority:  protocol.PriorityControl,
		Body:      body,
	})
	if err != nil || len(env) > protocol.MaxMessageBytes {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	wait, cancel := s.armFile(messageID)
	defer cancel()
	s.mu.Lock()
	current := s.link == link && link.ready
	s.mu.Unlock()
	if !current {
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	if err := s.send(ctx, link.ws, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
		s.log.Info("event=file_browse_send_failed", "node_id", nodeID, "operation_id", req.OperationID)
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	}
	s.log.Info("event=file_browse_sent", "node_id", nodeID, "operation_id", req.OperationID)
	timer := time.NewTimer(fileBrowseWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	case <-timer.C:
		s.log.Info("event=file_browse_timeout", "node_id", nodeID, "operation_id", req.OperationID)
		return protocol.FileResult{}, errors.New("节点暂时不可达")
	case notice := <-wait:
		if notice.bad || notice.transport != "" {
			s.log.Info("event=file_browse_transport", "node_id", nodeID, "operation_id", req.OperationID, "code", notice.transport)
			return protocol.FileResult{}, errors.New("节点暂时不可达")
		}
		if notice.source.Kind != protocol.SourceNode || notice.source.NodeID != nodeID || notice.source.EmployeeID != employeeID {
			s.log.Info("event=file_browse_source_rejected", "node_id", nodeID, "operation_id", req.OperationID)
			return protocol.FileResult{}, errors.New("节点暂时不可达")
		}
		if notice.result.OperationID != req.OperationID || notice.result.Type != protocol.BodyFileResult {
			s.log.Info("event=file_browse_result_rejected", "node_id", nodeID, "operation_id", req.OperationID)
			return protocol.FileResult{}, errors.New("节点暂时不可达")
		}
		if !notice.result.OK {
			notice.result.Content = nil
			notice.result.Entries = nil
			notice.result.Roots = nil
		}
		return notice.result, nil
	}
}

func (s *Server) armFile(messageID string) (<-chan fileNotice, func()) {
	ch := make(chan fileNotice, 1)
	s.mu.Lock()
	if s.fileWait == nil {
		s.fileWait = map[string]chan fileNotice{}
	}
	s.fileWait[messageID] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if s.fileWait[messageID] == ch {
			delete(s.fileWait, messageID)
		}
		s.mu.Unlock()
	}
}

func (s *Server) noteFileResult(env protocol.Envelope) {
	if env.Source == nil || env.CorrelationID == "" {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	dec.DisallowUnknownFields()
	var result protocol.FileResult
	if err := dec.Decode(&result); err != nil || result.Type != protocol.BodyFileResult {
		s.deliverFile(env.CorrelationID, fileNotice{bad: true})
		return
	}
	s.deliverFile(env.CorrelationID, fileNotice{result: result, source: *env.Source})
}

func (s *Server) noteFileTransport(messageID, code string) {
	if messageID == "" {
		return
	}
	s.deliverFile(messageID, fileNotice{transport: code})
}

func (s *Server) deliverFile(messageID string, notice fileNotice) {
	s.mu.Lock()
	ch := s.fileWait[messageID]
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- notice:
	default:
	}
}
