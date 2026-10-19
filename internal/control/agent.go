package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func (s *Server) onAgentRequest(ctx context.Context, connID string, env protocol.Envelope) {
	result := protocol.AgentResult{Type: protocol.BodyAgentResult, Code: task.CodeInvalidRequest}
	var req protocol.AgentRequest
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || req.Type != protocol.BodyAgentRequest {
		s.replyExecution(ctx, connID, env, result)
		return
	}
	source := store.AgentSource{EmployeeID: env.Source.EmployeeID, NodeID: env.Source.NodeID,
		TaskID: req.SourceTaskID, SessionID: req.SourceSessionID, ExecutionID: req.SourceExecutionID}
	var data any
	var err error
	switch req.Operation {
	case "delegate":
		if req.Input == nil || req.TaskID != "" {
			break
		}
		data, err = s.store.AcceptDelegation(ctx, source, *req.Input)
	case "get":
		if req.Input != nil {
			break
		}
		data, err = s.store.AgentTaskView(ctx, source, req.TaskID)
	case "result":
		if req.Input != nil {
			break
		}
		data, err = s.store.AgentResult(ctx, source, req.TaskID)
	case "relations":
		if req.Input != nil {
			break
		}
		data, err = s.store.AgentRelations(ctx, source, req.TaskID)
	case "cancel":
		if req.Input != nil {
			break
		}
		if _, err = s.store.AgentTask(ctx, source, req.TaskID); err == nil {
			data, err = s.store.RequestCancel(ctx, source.EmployeeID, req.TaskID)
		}
	}
	if err != nil {
		result.Code = task.CodeUnavailable
		var rejection *task.Rejection
		if errors.As(err, &rejection) {
			result.Code, result.Message, result.TaskID = rejection.Code, rejection.Message, rejection.TaskID
		}
	} else if data != nil {
		result.Data, err = json.Marshal(data)
		if err == nil {
			result.OK, result.Code = true, ""
		}
	}
	if raw, err := json.Marshal(result); err != nil || len(raw) > protocol.MaxMessageBytes-2048 {
		result = protocol.AgentResult{Type: protocol.BodyAgentResult, Code: task.CodeUnavailable, Message: "结果超过单条消息上限"}
	}
	s.replyExecution(ctx, connID, env, result)
}
