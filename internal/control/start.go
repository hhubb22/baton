package control

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
)

func (s *Server) onStartPermit(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil || env.Source.Kind != protocol.SourceNode {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	var req protocol.StartPermitRequest
	if err := dec.Decode(&req); err != nil || req.Type != protocol.BodyStartPermit {
		s.replyStart(ctx, connID, env, protocol.StartPermitResult{
			OK: false, Code: protocol.CodeInvalidMessage, Message: "启动许可请求无效",
		})
		return
	}
	decision, err := s.store.AuthorizeStart(ctx, store.StartRequest{
		EmployeeID:        env.Source.EmployeeID,
		NodeID:            env.Source.NodeID,
		CredentialID:      env.Source.CredentialID,
		TaskID:            req.TaskID,
		ExecutionID:       req.ExecutionID,
		SessionID:         req.SessionID,
		StorageGeneration: req.StorageGeneration,
		Nonce:             req.Nonce,
	})
	if err != nil || !decision.Issue {
		code := decision.Code
		message := decision.Message
		if err != nil {
			code = "unavailable"
			message = "暂时无法签发启动许可"
			s.log.Error("event=start_permit_failed", "task_id", req.TaskID, "node_id", env.Source.NodeID)
		} else if decision.PossibleStart {
			s.log.Info("event=start_possible", "task_id", req.TaskID, "node_id", env.Source.NodeID, "code", code)
		} else {
			s.log.Info("event=start_permit_rejected", "task_id", req.TaskID, "node_id", env.Source.NodeID, "code", code)
		}
		s.replyStart(ctx, connID, env, protocol.StartPermitResult{
			OK: false, Code: code, Message: message, TaskID: req.TaskID, ExecutionID: req.ExecutionID,
		})
		return
	}
	s.log.Info("event=start_authorized", "task_id", req.TaskID, "execution_id", req.ExecutionID, "node_id", env.Source.NodeID)
	if delay := startDelay(); delay > 0 {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
	token, err := s.signer.SignStartPermit(decision.Claims)
	if err != nil {
		// 授权已经提交。不能因为签名失败就把它说成未执行，节点可以用同一 nonce 再取一次。
		s.log.Error("event=start_permit_sign_failed", "task_id", req.TaskID, "node_id", env.Source.NodeID)
		s.replyStart(ctx, connID, env, protocol.StartPermitResult{
			OK: false, Code: "unavailable", Message: "暂时无法签发启动许可",
			TaskID: req.TaskID, ExecutionID: req.ExecutionID,
		})
		return
	}
	s.log.Info("event=start_permit_sent", "task_id", req.TaskID, "execution_id", req.ExecutionID, "node_id", env.Source.NodeID)
	s.replyStart(ctx, connID, env, protocol.StartPermitResult{
		OK: true, TaskID: req.TaskID, ExecutionID: req.ExecutionID, Permit: token,
	})
}

func (s *Server) onStartReport(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	var report protocol.StartReport
	if err := dec.Decode(&report); err != nil || report.Type != protocol.BodyStartReport || report.Started {
		s.reply(ctx, connID, env, false, protocol.CodeInvalidMessage)
		return
	}
	if err := s.store.RecordStartRefusal(ctx, env.Source.EmployeeID, env.Source.NodeID, report.TaskID, report.ExecutionID); err != nil {
		s.log.Error("event=start_report_failed", "task_id", report.TaskID, "node_id", env.Source.NodeID)
		s.reply(ctx, connID, env, false, "unavailable")
		return
	}
	s.log.Info("event=start_refused", "task_id", report.TaskID, "execution_id", report.ExecutionID, "node_id", env.Source.NodeID, "code", report.Code)
	s.reply(ctx, connID, env, true, "")
}

func (s *Server) replyStart(ctx context.Context, connID string, req protocol.Envelope, result protocol.StartPermitResult) {
	messageID, err := identity.NewUUID()
	if err != nil || req.Source == nil {
		return
	}
	result.Type = protocol.BodyStartPermitResult
	body, err := json.Marshal(result)
	if os.Getenv("BATON_TEST_START_PERMIT_EXTRA_FIELD") == "1" {
		body, err = json.Marshal(struct {
			protocol.StartPermitResult
			FutureField string `json:"future_field"`
		}{result, "compatibility-test"})
	}
	if err != nil {
		return
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:       protocol.Version,
		MessageID:     messageID,
		Route:         protocol.Route{To: req.Source.NodeID},
		Priority:      protocol.PriorityControl,
		CorrelationID: req.MessageID,
		Body:          body,
	})
	if err != nil {
		return
	}
	_ = s.send(ctx, connID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env})
}

func startDelay() time.Duration {
	raw := os.Getenv("BATON_TEST_START_DELAY")
	if raw == "" {
		return 0
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 || d > 30*time.Second {
		return 0
	}
	return d
}
