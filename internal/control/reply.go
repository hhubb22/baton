package control

import (
	"baton/internal/identity"
	"baton/internal/protocol"
	"context"
)

func (s *Server) replyNode(ctx context.Context, connID string, req protocol.Envelope, result any) {
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
		s.log.Info("event=node_message_too_large", "message_id", req.MessageID)
		return
	}
	_ = s.send(ctx, connID, frame)
}
