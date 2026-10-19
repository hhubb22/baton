package control

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

const prepareLease = 5 * time.Second

type prepareNotice struct {
	result protocol.PrepareResult
	source protocol.Source
	retry  bool
	code   string
}

// DeliverPrepares 消费 dispatch_outbox，经 Gateway 投递 prepare，并按租约重发同一消息。
func (s *Server) DeliverPrepares(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.store.ExpireExecutionsAt(ctx, time.Now()); err != nil {
				s.log.Error("event=execution_expire_failed")
			}
			if err := s.store.FailUnsentPrepares(ctx); err != nil {
				s.log.Error("event=prepare_expire_failed")
			}
			if err := s.store.ExpireQueuedTasks(ctx); err != nil {
				s.log.Error("event=queue_expire_failed")
			}
			if err := s.DispatchRevocations(ctx); err != nil {
				s.log.Info("event=revocation_apply_failed")
			}
			s.deliverOne(ctx)
		}
	}
}

func (s *Server) deliverOne(ctx context.Context) {

	intent, ok, err := s.store.ClaimPrepare(ctx, prepareLease)
	if err != nil {
		s.log.Error("event=prepare_claim_failed")
		return
	}
	if !ok {
		return
	}
	ch, cancel := s.armPrepare(intent.MessageID)
	defer cancel()
	body, err := json.Marshal(protocol.PrepareCommand{
		RequiredArtifacts: intent.RequiredArtifacts,
		Type:              protocol.BodyPrepare,
		TaskID:            intent.TaskID,
		ExecutionID:       intent.ExecutionID,
		TaskVersion:       intent.TaskVersion,
		StorageGeneration: intent.StorageGeneration,
		QueueExpiresAt:    intent.QueueExpiresAt.Format(time.RFC3339Nano),
		AgentType:         intent.AgentType,
		TargetSessionID:   intent.TargetSessionID,
		WorkingDirectory:  intent.WorkingDirectory,
	})
	if err != nil {
		_ = s.store.ReleasePrepare(ctx, intent.MessageID)
		return
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:   protocol.Version,
		MessageID: intent.MessageID,
		Route:     protocol.Route{To: intent.NodeID},
		Priority:  protocol.PriorityControl,
		Body:      body,
	})
	if err != nil {
		_ = s.store.ReleasePrepare(ctx, intent.MessageID)
		return
	}

	if err := s.send(ctx, "", protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
		_ = s.store.ReleasePrepare(ctx, intent.MessageID)
		s.log.Info("event=prepare_send_failed", "task_id", intent.TaskID, "node_id", intent.NodeID)
		return
	}
	s.log.Info("event=prepare_sent", "message_id", intent.MessageID, "task_id", intent.TaskID, "node_id", intent.NodeID)
	timer := time.NewTimer(prepareLease)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		if err := s.store.MarkPrepareSent(ctx, intent.MessageID); err != nil {
			s.log.Error("event=prepare_attempt_failed", "task_id", intent.TaskID)
		}
		s.log.Info("event=prepare_timeout", "message_id", intent.MessageID, "task_id", intent.TaskID)
	case notice := <-ch:
		if notice.retry {
			if err := s.store.ReleasePrepare(ctx, intent.MessageID); err != nil {
				s.log.Error("event=prepare_release_failed", "task_id", intent.TaskID)
			}
			s.log.Info("event=prepare_retry", "message_id", intent.MessageID, "task_id", intent.TaskID, "code", notice.code)
			return
		}
		if notice.source.NodeID == "" {
			if err := s.store.FailPrepare(ctx, store.PreparedFact{MessageID: intent.MessageID}, task.CodeUnavailable, "准备命令无法转发"); err != nil {
				s.log.Error("event=prepare_save_failed", "task_id", intent.TaskID)
			}
			return
		}
		s.finishPrepare(ctx, intent, notice)
	}
}

func (s *Server) finishPrepare(ctx context.Context, intent store.PrepareIntent, notice prepareNotice) {
	if notice.source.Kind != protocol.SourceNode || notice.source.NodeID != intent.NodeID || notice.source.EmployeeID != intent.EmployeeID {
		s.log.Info("event=prepare_source_rejected", "task_id", intent.TaskID, "node_id", intent.NodeID)
		return
	}
	fact := store.PreparedFact{
		MessageID:   intent.MessageID,
		EmployeeID:  intent.EmployeeID,
		NodeID:      intent.NodeID,
		TaskID:      intent.TaskID,
		ExecutionID: intent.ExecutionID,
	}
	var err error
	if notice.result.OK {
		if notice.result.TaskID != intent.TaskID || notice.result.ExecutionID != intent.ExecutionID {
			s.log.Info("event=prepare_mapping_rejected", "task_id", intent.TaskID)
			return
		}
		fact.SessionID = notice.result.SessionID
		fact.StorageGeneration = notice.result.StorageGeneration
		err = s.store.SavePrepared(ctx, fact)
	} else {
		err = s.store.FailPrepare(ctx, fact, notice.result.Code, notice.result.Message)
	}
	if err != nil {
		s.log.Error("event=prepare_save_failed", "task_id", intent.TaskID)
		return
	}
	s.log.Info("event=prepare_saved", "task_id", intent.TaskID, "node_id", intent.NodeID, "ok", notice.result.OK)
}

func (s *Server) armPrepare(messageID string) (<-chan prepareNotice, func()) {
	ch := make(chan prepareNotice, 1)
	s.mu.Lock()
	s.pending[messageID] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if s.pending[messageID] == ch {
			delete(s.pending, messageID)
		}
		s.mu.Unlock()
	}
}

func (s *Server) notePrepareResult(env protocol.Envelope) {
	if env.Source == nil || env.CorrelationID == "" {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	var result protocol.PrepareResult
	if err := dec.Decode(&result); err != nil || result.Type != protocol.BodyPrepareResult {
		return
	}
	s.mu.Lock()
	ch := s.pending[env.CorrelationID]
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- prepareNotice{result: result, source: *env.Source}:
	default:
	}
}

func (s *Server) notePrepareTransport(messageID, code string) {
	if messageID == "" {
		return
	}
	retry := code == protocol.CodeNodeUnavailable || code == protocol.CodeQueueFull || code == protocol.CodeControlUnavailable
	s.mu.Lock()
	ch := s.pending[messageID]
	s.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- prepareNotice{retry: retry, code: code}:
	default:
	}
}
