package control

import (
	"context"
	"encoding/json"
	"time"

	"baton/internal/protocol"
	"baton/internal/store"
)

const prepareLease = 5 * time.Second

// DeliverPrepares 每 200ms 投递至多 32 条 prepare；节点回包由入站处理保存。
func (s *Server) DeliverPrepares(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.deliverPrepareBatch(ctx)
		}
	}
}

func (s *Server) deliverPrepareBatch(ctx context.Context) {
	var intents []store.PrepareIntent
	err := s.backgroundDB(ctx, func(dbctx context.Context) error {
		var err error
		intents, err = s.store.ClaimPrepares(dbctx, prepareLease, 32)
		return err
	})
	if err != nil {
		s.log.Error("event=prepare_claim_failed")
		return
	}
	for _, intent := range intents {
		if ctx.Err() != nil {
			return
		}
		if err := s.send(ctx, "", protocol.Frame{Kind: protocol.KindEnvelope, Envelope: intent.Envelope}); err != nil {
			s.log.Info("event=prepare_send_failed", "task_id", intent.TaskID, "node_id", intent.NodeID)
			continue
		}
		s.log.Info("event=prepare_sent", "message_id", intent.MessageID, "task_id", intent.TaskID, "node_id", intent.NodeID)
	}
}

func (s *Server) notePrepareResult(ctx context.Context, env protocol.Envelope) {
	if env.Source == nil || env.Source.Kind != protocol.SourceNode || env.CorrelationID == "" {
		return
	}
	var result protocol.PrepareResult
	if err := json.Unmarshal(rawBody(env.Body), &result); err != nil || result.Type != protocol.BodyPrepareResult {
		return
	}
	fact, err := s.store.PrepareBinding(ctx, env.CorrelationID)
	if err != nil {
		s.log.Info("event=prepare_binding_unavailable")
		return
	}
	if env.Source.NodeID != fact.NodeID || env.Source.EmployeeID != fact.EmployeeID {
		s.log.Info("event=prepare_source_rejected", "task_id", fact.TaskID)
		return
	}
	if (result.OK && (result.TaskID != fact.TaskID || result.ExecutionID != fact.ExecutionID)) ||
		(result.TaskID != "" && result.TaskID != fact.TaskID) ||
		(result.ExecutionID != "" && result.ExecutionID != fact.ExecutionID) {
		s.log.Info("event=prepare_mapping_rejected", "task_id", fact.TaskID)
		return
	}
	if result.OK {
		fact.SessionID = result.SessionID
		fact.StorageGeneration = result.StorageGeneration
		err = s.store.SavePrepared(ctx, fact)
	} else {
		err = s.store.FailPrepare(ctx, fact, result.Code, result.Message)
	}
	if err != nil {
		s.log.Error("event=prepare_save_failed", "task_id", fact.TaskID)
		return
	}
	s.log.Info("event=prepare_saved", "task_id", fact.TaskID, "node_id", fact.NodeID, "ok", result.OK)
}
