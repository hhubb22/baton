package control

import (
	"bytes"
	"context"
	"encoding/json"

	"baton/internal/protocol"
	"baton/internal/store"
)

func (s *Server) onChildDelivery(ctx context.Context, connID string, env protocol.Envelope) {
	if env.Source == nil || env.Source.Kind != protocol.SourceNode {
		return
	}
	var req protocol.ChildDeliveryRequest
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	result := protocol.ChildDeliveriesResult{Type: protocol.BodyChildDeliveriesResult}
	if dec.Decode(&req) == nil {
		source := store.AgentSource{EmployeeID: env.Source.EmployeeID, NodeID: env.Source.NodeID,
			TaskID: req.TaskID, ExecutionID: req.ExecutionID, SessionID: req.SessionID}
		if req.Type == protocol.BodyChildDeliveries && req.Receipt == nil {
			var err error
			result.Deliveries, err = s.store.ChildDeliveries(ctx, source, req.ChildTaskID)
			result.OK = err == nil
		} else if req.Type == protocol.BodyChildDeliveryAck && req.Receipt != nil {
			result.OK = s.store.RecordChildReceipt(ctx, source, *req.Receipt) == nil
		}
	}
	if raw, err := json.Marshal(result); err != nil || len(raw) > protocol.MaxMessageBytes-2048 {
		result = protocol.ChildDeliveriesResult{Type: protocol.BodyChildDeliveriesResult}
	}
	s.replyExecution(ctx, connID, env, result)
}
