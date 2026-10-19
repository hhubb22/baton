package control

import (
	"baton/internal/gateway"
	"baton/internal/protocol"
	"context"
	"encoding/json"
)

// DispatchRevocations 在持久化决定后禁止本地接入并关闭连接，再记录生效事实。
func (s *Server) DispatchRevocations(ctx context.Context) error {
	creds, _, ids, err := s.store.PendingRevocationSet(ctx)
	if err != nil || len(ids) == 0 {
		return err
	}
	if s.sender == nil {
		return gateway.ErrUnavailable
	}
	for _, cred := range creds {
		s.sender.DisconnectCredential(cred.ID)
	}
	return s.store.MarkRevocationsApplied(ctx, ids)
}

func (s *Server) send(ctx context.Context, connID string, frame protocol.Frame) error {
	if s.sender == nil {
		return gateway.ErrUnavailable
	}
	if frame.Kind != protocol.KindEnvelope {
		return protocol.ErrInvalidMessage
	}
	var env protocol.Envelope
	if json.Unmarshal(frame.Envelope, &env) != nil {
		return protocol.ErrInvalidMessage
	}
	return s.sender.Send(ctx, env.Route.To, connID, env)
}
