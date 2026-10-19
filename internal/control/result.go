package control

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func (s *Server) onExecutionInput(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil || env.Source.Kind != protocol.SourceNode {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	var req protocol.InputRequest
	if err := dec.Decode(&req); err != nil || req.Type != protocol.BodyExecutionInput {
		s.replyInput(ctx, connID, env, protocol.InputResult{OK: false, Code: protocol.CodeInvalidMessage, Message: "任务输入请求无效"})
		return
	}
	input, code, err := s.store.LoadTaskInput(ctx, env.Source.EmployeeID, env.Source.NodeID, req.TaskID, req.ExecutionID, req.SessionID)
	if err != nil {
		s.log.Error("event=execution_input_failed", "task_id", req.TaskID, "node_id", env.Source.NodeID)
		s.replyInput(ctx, connID, env, protocol.InputResult{OK: false, Code: task.CodeUnavailable, Message: "暂时不能读取任务输入"})
		return
	}
	if code != "" {
		s.log.Info("event=execution_input_rejected", "task_id", req.TaskID, "node_id", env.Source.NodeID, "code", code)
		s.replyInput(ctx, connID, env, protocol.InputResult{OK: false, Code: code, Message: "现在不能提交任务输入", TaskID: req.TaskID, ExecutionID: req.ExecutionID})
		return
	}
	s.log.Info("event=execution_input", "task_id", req.TaskID, "execution_id", req.ExecutionID, "node_id", env.Source.NodeID)
	s.replyInput(ctx, connID, env, protocol.InputResult{
		OK: true, TaskID: req.TaskID, ExecutionID: req.ExecutionID, Generation: input.Generation,
		Description: input.Description, AuthorizationScope: input.AuthorizationScope,
		ExpectedOutputs: input.ExpectedOutputs, WorkingDirectory: input.WorkingDirectory,
		DeviceNames: input.DeviceNames, RequiredArtifacts: input.RequiredArtifacts,
	})
}

func (s *Server) onExecutionReport(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil || env.Source.Kind != protocol.SourceNode {
		return
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	var report protocol.ExecutionReport
	if err := dec.Decode(&report); err != nil || report.Type != protocol.BodyExecutionReport {
		s.replyReport(ctx, connID, env, protocol.ReportAck{OK: false, Code: protocol.CodeInvalidMessage})
		return
	}
	if report.Kind == protocol.ReportResult {
		if err := waitResultGate(ctx, report.EventID, s); err != nil {
			return
		}
	}
	ack, code, err := s.store.ApplyExecutionReport(ctx, store.ExecutionReport{
		WorkerSequence:     report.WorkerSequence,
		QueueDeadlineMet:   report.QueueDeadlineMet,
		ExecutionElapsedMS: report.ExecutionElapsedMS,
		OccurredAt:         report.OccurredAt, NotStarted: report.NotStarted, OutcomeKnown: report.OutcomeKnown, StopReason: report.StopReason,
		EmployeeID: env.Source.EmployeeID, NodeID: env.Source.NodeID,
		EventID: report.EventID, TaskID: report.TaskID, ExecutionID: report.ExecutionID, SessionID: report.SessionID,
		Kind: report.Kind, InputGeneration: report.InputGeneration, Status: report.Status,
		Summary: report.Summary, Evidence: report.Evidence, Artifacts: report.Artifacts,
		EvidenceEmptyReason: report.EvidenceEmptyReason, ArtifactsEmptyReason: report.ArtifactsEmptyReason,
		ErrorCode: report.ErrorCode, ErrorMessage: report.ErrorMessage, AgentStopped: report.AgentStopped,
	})
	if err != nil {
		s.log.Error("event=execution_report_failed", "task_id", report.TaskID, "event_id", report.EventID, "node_id", env.Source.NodeID)
		s.replyReport(ctx, connID, env, protocol.ReportAck{OK: false, Code: task.CodeUnavailable, EventID: report.EventID})
		return
	}
	if !ack {
		s.log.Info("event=execution_report_rejected", "task_id", report.TaskID, "event_id", report.EventID, "code", code)
		s.replyReport(ctx, connID, env, protocol.ReportAck{OK: false, Code: code, EventID: report.EventID})
		return
	}
	s.log.Info("event=execution_report_stored", "task_id", report.TaskID, "event_id", report.EventID, "kind", report.Kind, "status", report.Status)
	s.replyReport(ctx, connID, env, protocol.ReportAck{OK: true, EventID: report.EventID})
}

func (s *Server) onExecutionControl(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil || env.Source.Kind != protocol.SourceNode {
		return
	}
	var req protocol.InputRequest
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	result := protocol.ExecutionControl{Type: protocol.BodyExecutionControlResult}
	if err := dec.Decode(&req); err != nil || req.Type != protocol.BodyExecutionControl {
		result.Code = protocol.CodeInvalidMessage
	} else {
		reason, seconds, err := s.store.ExecutionControl(ctx, env.Source.EmployeeID, env.Source.NodeID, req.TaskID, req.ExecutionID, req.SessionID)
		if err != nil {
			result.Code = task.CodeUnavailable
		} else {
			result.OK = true
			result.StopReason = reason
			result.ExecutionTimeoutSeconds = seconds
		}
	}
	s.replyExecution(ctx, connID, env, result)
}

func (s *Server) replyInput(ctx context.Context, connID string, req protocol.Envelope, result protocol.InputResult) {
	result.Type = protocol.BodyExecutionInputResult
	if body, err := json.Marshal(result); err != nil || len(body) > protocol.MaxMessageBytes-512 {
		result = protocol.InputResult{
			Type: protocol.BodyExecutionInputResult, OK: false, Code: protocol.CodeMessageTooLarge,
			Message: "任务输入超过传输上限", TaskID: result.TaskID, ExecutionID: result.ExecutionID,
		}
	}
	s.replyExecution(ctx, connID, req, result)
}

func (s *Server) replyReport(ctx context.Context, connID string, req protocol.Envelope, result protocol.ReportAck) {
	result.Type = protocol.BodyExecutionReportResult
	s.replyExecution(ctx, connID, req, result)
}

func (s *Server) replyExecution(ctx context.Context, connID string, req protocol.Envelope, result any) {
	messageID, err := identity.NewUUID()
	if err != nil || req.Source == nil {
		return
	}
	body, err := protocol.MarshalJSON(result)
	if err != nil {
		return
	}
	env, err := protocol.MarshalJSON(protocol.Envelope{
		Version: protocol.Version, MessageID: messageID,
		Route: protocol.Route{To: req.Source.NodeID}, Priority: protocol.PriorityControl,
		CorrelationID: req.MessageID, Body: body,
	})
	if err != nil {
		return
	}
	frame := protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}
	raw, err := protocol.MarshalJSON(frame)
	if err != nil || len(raw) > protocol.MaxMessageBytes {
		s.log.Info("event=execution_message_too_large", "message_id", req.MessageID)
		return
	}
	_ = s.send(ctx, connID, frame)
}

func waitResultGate(ctx context.Context, eventID string, s *Server) error {
	dir := os.Getenv("BATON_TEST_RESULT_GATE")
	if dir == "" || eventID == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "waiting-"+eventID), []byte("1\n"), 0o600); err != nil {
		return err
	}
	s.log.Info("event=result_gated", "event_id", eventID)
	release := filepath.Join(dir, "release-"+eventID)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := os.Stat(release); err == nil {
			return nil
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
