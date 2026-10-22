package node

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

// runtimeRPC 在当前节点连接上匹配 Project Runtime 请求与回包。
type runtimeRPC struct {
	writer  *wsWriter
	mu      sync.Mutex
	waiters map[string]chan json.RawMessage
}

func newRuntimeRPC(writer *wsWriter) *runtimeRPC {
	return &runtimeRPC{writer: writer}
}

func (s *runtimeRPC) roundTrip(ctx context.Context, body []byte) (json.RawMessage, error) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	env, err := protocol.MarshalJSON(protocol.Envelope{
		Version: protocol.Version, MessageID: messageID,
		Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, Body: body,
	})
	if err != nil || len(env) > protocol.MaxMessageBytes {
		return nil, errors.New("消息超过上限")
	}
	frame, err := protocol.MarshalJSON(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		return nil, errors.New("消息超过上限")
	}
	ch := s.register(messageID)
	defer s.unregister(messageID)
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := s.writer.write(callCtx, frame); err != nil {
		return nil, err
	}
	select {
	case <-callCtx.Done():
		return nil, callCtx.Err()
	case raw := <-ch:
		return raw, nil
	}
}

func (s *runtimeRPC) register(messageID string) chan json.RawMessage {
	ch := make(chan json.RawMessage, 1)
	s.mu.Lock()
	if s.waiters == nil {
		s.waiters = map[string]chan json.RawMessage{}
	}
	s.waiters[messageID] = ch
	s.mu.Unlock()
	return ch
}

func (s *runtimeRPC) unregister(messageID string) {
	s.mu.Lock()
	delete(s.waiters, messageID)
	s.mu.Unlock()
}

func (s *runtimeRPC) onReply(env protocol.Envelope) bool {
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(env.Body, &kind); err != nil {
		return false
	}
	switch kind.Type {
	case protocol.BodyProjectRuntimeResult:
	default:
		return false
	}
	s.mu.Lock()
	ch := s.waiters[env.CorrelationID]
	s.mu.Unlock()
	if ch != nil {
		select {
		case ch <- append(json.RawMessage(nil), env.Body...):
		default:
		}
	}
	return true
}
