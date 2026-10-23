package node

import (
	"baton/internal/identity"
	"baton/internal/projectexec"
	"baton/internal/protocol"
	"context"
	"encoding/json"
	"os/user"
)

func handleNodeSettings(ctx context.Context, raw []byte, w *wsWriter, dir string, reports *runtimeReports) bool {
	var wrap struct {
		Envelope protocol.Envelope `json:"envelope"`
	}
	if json.Unmarshal(raw, &wrap) != nil {
		return false
	}
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(wrap.Envelope.Body, &head) != nil || head.Type != protocol.BodyProjectExecSet {
		return false
	}
	env := wrap.Envelope
	if env.Source == nil || env.Source.Kind != protocol.SourceControl {
		return true
	}
	var req protocol.ProjectExecRequest
	result := protocol.ProjectExecResult{Type: protocol.BodyProjectExecResult, Code: "invalid_request"}
	if protocol.DecodeRuntimeMessage(env.Body, &req) == nil {
		result.OperationID = req.OperationID
		if _, err := identity.ParseUUID(req.OperationID); err == nil {
			cfg, err := projectexec.SetEnabled(dir, req.Enabled)
			if err != nil {
				result.Code = "config_unavailable"
			} else {
				result.OK = true
				result.Code = ""
				cfg.User = ""
				if current, err := user.Current(); err == nil {
					cfg.User = current.Username
				}
				result.Exec = &cfg
				if reports != nil {
					select {
					case reports.refresh <- struct{}{}:
					default:
					}
				}
			}
		}
	}
	messageID, err := identity.NewUUID()
	if err != nil {
		return true
	}
	body, _ := json.Marshal(result)
	rawEnv, _ := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: messageID, Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, CorrelationID: env.MessageID, Body: body})
	frame, _ := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: rawEnv})
	_ = w.write(ctx, frame)
	return true
}
