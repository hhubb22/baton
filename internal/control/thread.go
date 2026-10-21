package control

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
)

// DeliverThreads 与维护和旧任务派发分别运行，发送后由入站路径独立保存回执。
func (s *Server) DeliverThreads(ctx context.Context) {
	s.periodic(ctx, 200*time.Millisecond, "thread_delivery", s.deliverThreadBatch)
}
func (s *Server) deliverThreadBatch(ctx context.Context) error {
	var intents []store.ThreadIntent
	err := s.backgroundDB(ctx, func(ctx context.Context) error {
		var err error
		intents, err = s.store.ClaimThreadCommands(ctx)
		return err
	})
	if err != nil {
		return err
	}
	for _, in := range intents {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := s.send(ctx, in.ConnID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: in.Envelope}); err != nil {
			s.log.Info("event=thread_send_failed", "thread_id", in.ThreadID, "node_id", in.NodeID)
		}
	}
	return nil
}
func (s *Server) onThreadCommandResult(ctx context.Context, env protocol.Envelope) {
	if env.Source == nil {
		return
	}
	var result protocol.ThreadCommandResult
	if json.Unmarshal(env.Body, &result) != nil {
		return
	}
	if err := s.store.SaveThreadCommandResult(ctx, *env.Source, env.CorrelationID, result); err != nil {
		s.log.Info("event=thread_command_result_rejected", "node_id", env.Source.NodeID)
	}
}
func (s *Server) onThreadReport(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil {
		return
	}
	var report protocol.ThreadReport
	if json.Unmarshal(env.Body, &report) != nil {
		return
	}
	ack, err := s.store.SaveThreadReport(ctx, *env.Source, report)
	if err != nil {
		ack.OK = false
		ack.Code = "unavailable"
		var rejection *store.ThreadError
		if errors.As(err, &rejection) {
			ack.Code = rejection.Code
		} else if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrSyncRejected) {
			ack.Code = "report_rejected"
		}
	}
	body, err := protocol.MarshalJSON(ack)
	if err != nil {
		return
	}
	id, err := identity.NewUUID()
	if err != nil {
		return
	}
	raw, err := protocol.MarshalJSON(protocol.Envelope{Version: protocol.Version, MessageID: id, Route: protocol.Route{To: env.Source.NodeID}, Priority: protocol.PriorityControl, CorrelationID: env.MessageID, Body: body})
	if err == nil {
		_ = s.send(ctx, connID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: raw})
	}
}
