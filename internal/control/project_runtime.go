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
		if utf8.Valid(env.Body) && dec.Decode(&req) == nil && req.Type == protocol.BodyProjectRuntimeRequest && errors.Is(dec.Decode(&struct{}{}), io.EOF) {
			data, err := s.store.ProjectRuntime(ctx, *env.Source, req)
			switch {
			case err == nil:
				if req.Operation == "preview" {
					var p projectagent.Preview
					_ = json.Unmarshal(req.Payload, &p)
					p.AfterSeq = req.LastSeq
					s.saveProjectPreview(req.RunID, p)
				}
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

// ScheduleProjectRunsLoop 独立执行放置与租约回收，每次数据库操作共用后台并发门。
func (s *Server) ScheduleProjectRunsLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	after := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			after = s.scheduleProjectRunsPage(ctx, after)
		}
	}
}

func (s *Server) scheduleProjectRunsPage(ctx context.Context, after string) string {
	var ids []string
	if err := s.backgroundDB(ctx, func(dbctx context.Context) (err error) {
		ids, err = s.store.ListProjectRunCandidates(dbctx, after, 32)
		return err
	}); err != nil {
		s.log.Error("event=project_run_scan_failed")
		return after
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return after
		}
		if err := s.backgroundDB(ctx, func(dbctx context.Context) error {
			return s.store.ScheduleProjectRun(dbctx, id)
		}); err != nil {
			s.log.Error("event=project_run_schedule_failed", "agent_id", id)
		}
		after = id
	}
	if len(ids) < 32 {
		return ""
	}
	return after
}

// DeliverProjectRuns 每秒独立领取三类命令，持久化重试进度后立即入队。
func (s *Server) DeliverProjectRuns(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	order := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.deliverProjectRunsInOrder(ctx, order)
			order = (order + 1) % 3
		}
	}
}

func (s *Server) deliverProjectRuns(ctx context.Context) {
	s.deliverProjectRunsInOrder(ctx, 0)
}

func (s *Server) deliverProjectRunsInOrder(ctx context.Context, order int) {
	kinds := []string{protocol.BodyProjectRunStart, protocol.BodyProjectRunStop, protocol.BodyProjectRunWake}
	for i := range kinds {
		if ctx.Err() != nil {
			return
		}
		var commands []projectagent.RunCommand
		if err := s.backgroundDB(ctx, func(dbctx context.Context) (err error) {
			commands, err = s.store.ClaimProjectRunCommands(dbctx, kinds[(order+i)%len(kinds)])
			return err
		}); err != nil {
			s.log.Error("event=project_run_commands_failed", "kind", kinds[(order+i)%len(kinds)])
			continue
		}
		// 数据库并发门已经释放；入队错误由持久化的下一次尝试时间处理。
		for _, command := range commands {
			s.sendProjectRunCommand(ctx, command)
		}
	}
}

func (s *Server) sendProjectRunCommand(ctx context.Context, command projectagent.RunCommand) {
	messageID := command.Command.RunID
	if command.Command.Type != protocol.BodyProjectRunStart {
		var err error
		messageID, err = identity.NewUUID()
		if err != nil {
			return
		}
	}
	body, err := protocol.MarshalJSON(command.Command)
	if err != nil || len(body) > protocol.MaxProjectRuntimeBytes {
		s.log.Error("event=project_run_command_invalid", "run_id", command.Command.RunID)
		return
	}
	env, err := protocol.MarshalJSON(protocol.Envelope{
		Version: protocol.Version, MessageID: messageID,
		Route: protocol.Route{To: command.NodeID}, Priority: protocol.PriorityControl, Body: body,
	})
	if err != nil {
		return
	}
	if err := s.send(ctx, command.ConnID, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env}); err != nil {
		s.log.Info("event=project_run_send_failed", "node_id", command.NodeID, "run_id", command.Command.RunID)
	}
}
