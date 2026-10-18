package node

import (
	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"
	"context"
	"encoding/json"
	"time"
)

func handleSessionEnvelope(ctx context.Context, raw []byte, w *wsWriter, host *session.Host, ledger *Ledger) bool {
	var frame struct {
		Envelope protocol.Envelope `json:"envelope"`
	}
	if json.Unmarshal(raw, &frame) != nil {
		return false
	}
	var req protocol.SessionRequest
	if json.Unmarshal(frame.Envelope.Body, &req) != nil || req.Type != protocol.BodySessionRequest {
		return false
	}
	if frame.Envelope.Source == nil || frame.Envelope.Source.Kind != protocol.SourceControl {
		return true
	}
	select {
	case w.sessionSlots <- struct{}{}:
	default:
		return true
	}
	go func() {
		defer func() { <-w.sessionSlots }()
		result := protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID, Code: "unavailable"}
		if host != nil {
			bounded, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			if got, err := host.BrowserRequest(bounded, req); err == nil {
				result = got
				if req.Action == "resume" && result.OK && result.State == "idle" && ledger != nil {
					if err := ledger.releaseSession(req.SessionID, result.ExecutionID); err != nil {
						result.OK = false
						result.Code = "unavailable"
					}
				}
			}
		}
		id, err := identity.NewUUID()
		if err != nil {
			return
		}
		body, _ := json.Marshal(result)
		priority := protocol.PriorityControl
		if req.Action == "output" {
			priority = protocol.PriorityOutput
		}
		env, _ := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: id, CorrelationID: frame.Envelope.MessageID, Route: protocol.Route{To: protocol.ToControl}, Priority: priority, Body: body})
		reply, _ := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env})
		_ = w.write(ctx, reply)
	}()
	return true
}
