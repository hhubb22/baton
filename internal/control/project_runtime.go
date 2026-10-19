package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/projectagent"
	"baton/internal/protocol"
)

func (s *Server) onProjectRuntimeRequest(ctx context.Context, connID string, env protocol.Envelope) {
	result := protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, Code: "invalid_request"}
	if len(env.Body) > protocol.MaxProjectRuntimeBytes {
		result.Code = "too_large"
	} else {
		var req protocol.ProjectRuntimeRequest
		dec := json.NewDecoder(bytes.NewReader(env.Body))
		dec.DisallowUnknownFields()
		if utf8.Valid(env.Body) && dec.Decode(&req) == nil && req.Type == protocol.BodyProjectRuntimeRequest && errors.Is(dec.Decode(&struct{}{}), io.EOF) {
			data, err := s.store.ProjectRuntime(ctx, *env.Source, req)
			switch {
			case err == nil:
				result.Data, err = protocol.MarshalJSON(data)
				if err == nil {
					result.OK, result.Code = true, ""
				} else {
					result.Code = "unavailable"
				}
			case errors.Is(err, projectagent.ErrLeaseLost):
				result.Code = "lease_lost"
			case errors.Is(err, projectagent.ErrInvalid):
				result.Code = "invalid_request"
			case errors.Is(err, projectagent.ErrConflict):
				result.Code = "seq_conflict"
			case errors.Is(err, projectagent.ErrTooLarge):
				result.Code = "too_large"
			default:
				result.Code = "unavailable"
			}
		}
	}
	if raw, err := protocol.MarshalJSON(result); err != nil || len(raw) > protocol.MaxProjectRuntimeBytes {
		result = protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, Code: "too_large"}
	}
	s.replyExecution(ctx, connID, env, result)
}

// DeliverProjectRuns 每秒取得租约并重发启动、停止和唤醒命令，投递事实由节点回执保存。
func (s *Server) DeliverProjectRuns(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.deliverProjectRuns(ctx)
		}
	}
}

func (s *Server) deliverProjectRuns(ctx context.Context) {
	if err := s.store.ScheduleProjectRuns(ctx); err != nil {
		s.log.Error("event=project_run_schedule_failed")
	}
	commands, err := s.store.ProjectRunCommands(ctx)
	if err != nil {
		s.log.Error("event=project_run_commands_failed")
		return
	}
	for _, command := range commands {
		messageID := command.Command.RunID
		if command.Command.Type != protocol.BodyProjectRunStart {
			messageID, err = identity.NewUUID()
			if err != nil {
				return
			}
		}
		body, err := protocol.MarshalJSON(command.Command)
		if err != nil || len(body) > protocol.MaxProjectRuntimeBytes {
			s.log.Error("event=project_run_command_invalid", "run_id", command.Command.RunID)
			continue
		}
		env, err := protocol.MarshalJSON(protocol.Envelope{
			Version: protocol.Version, MessageID: messageID,
			Route: protocol.Route{To: command.NodeID}, Priority: protocol.PriorityControl, Body: body,
		})
		if err != nil {
			continue
		}
		if err := s.send(ctx, command.ConnID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
			s.log.Info("event=project_run_send_failed", "node_id", command.NodeID, "run_id", command.Command.RunID)
		}
	}
}
