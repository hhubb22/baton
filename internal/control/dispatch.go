package control

import (
	"baton/internal/gateway"
	"baton/internal/protocol"
	"context"
	"encoding/json"
)

// DispatchRevocations 在持久化决定后禁止本地接入并关闭连接，再记录生效事实。
func (s *Server) DispatchRevocations(ctx context.Context) error {
	return s.dispatchRevocations(ctx, false)
}

func (s *Server) dispatchRevocations(ctx context.Context, background bool) error {
	run := func(fn func(context.Context) error) error { return fn(ctx) }
	if background {
		run = func(fn func(context.Context) error) error { return s.backgroundDB(ctx, fn) }
	}
	var creds []protocol.Revocation
	var ids []string
	err := run(func(ctx context.Context) (err error) {
		if background {
			creds, _, ids, err = s.store.PendingRevocationBatch(ctx)
		} else {
			creds, _, ids, err = s.store.PendingRevocationSet(ctx)
		}
		return err
	})
	if err != nil || len(ids) == 0 {
		return err
	}
	if s.sender == nil {
		return gateway.ErrUnavailable
	}
	for _, cred := range creds {
		s.sender.DisconnectCredential(cred.ID)
	}
	return run(func(ctx context.Context) error { return s.store.MarkRevocationsApplied(ctx, ids) })
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
