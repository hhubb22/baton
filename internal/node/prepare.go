package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"

	"github.com/coder/websocket"
)

type wsWriter struct {
	sessionSlots chan struct{}
	ws           *websocket.Conn
	mu           sync.Mutex
}

func newWSWriter(ws *websocket.Conn) *wsWriter {
	return &wsWriter{ws: ws, sessionSlots: make(chan struct{}, 16)}
}

func (w *wsWriter) write(ctx context.Context, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.ws.Write(ctx, websocket.MessageText, payload)
}

func handleNodeEnvelope(ctx context.Context, raw []byte, w *wsWriter, ledger *Ledger, host *session.Host, caps []string, log *slog.Logger, loop *startLoop) bool {
	var wrap struct {
		Envelope protocol.Envelope `json:"envelope"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return false
	}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(wrap.Envelope.Body, &kind); err != nil {
		return false
	}
	if kind.Type == protocol.BodyStartPermitResult {
		return loop.onResult(wrap.Envelope)
	}
	if loop != nil && loop.onReply(wrap.Envelope) {
		return true
	}
	if kind.Type != protocol.BodyPrepare {
		return false
	}
	if wrap.Envelope.Source == nil || wrap.Envelope.Source.Kind != protocol.SourceControl {
		log.Info("event=prepare_ignored")
		return true
	}
	if ledger == nil {
		log.Info("event=prepare_not_persisted")
		return true
	}
	dec := json.NewDecoder(bytes.NewReader(wrap.Envelope.Body))
	var cmd protocol.PrepareCommand
	if err := dec.Decode(&cmd); err != nil || cmd.Type != protocol.BodyPrepare {
		writePrepareResult(ctx, w, wrap.Envelope.MessageID, PrepareReport{
			Code: "invalid_target", Message: "准备命令无效",
		})
		return true
	}
	expires, err := time.Parse(time.RFC3339Nano, cmd.QueueExpiresAt)
	if err != nil {
		writePrepareResult(ctx, w, wrap.Envelope.MessageID, PrepareReport{
			Code: "invalid_target", Message: "准备命令无效",
		})
		return true
	}
	nodeID := ""
	if loop != nil {
		nodeID = loop.ident.NodeID
	}
	if cmd.TargetSessionID != "" && cmd.WorkingDirectory != "" && host != nil {
		operation, _ := identity.NewUUID()
		checked, err := host.BrowserRequest(ctx, protocol.SessionRequest{SessionID: cmd.TargetSessionID, OperationID: operation, Action: "validate_directory", Text: cmd.WorkingDirectory})
		if err != nil || !checked.OK {
			writePrepareResult(ctx, w, wrap.Envelope.MessageID, PrepareReport{Code: "invalid_target", Message: "复用 Session 的工作目录无法确认或与原目录不一致"})
			return true
		}
	}
	report := ledger.Prepare(PrepareInput{
		NodeID: nodeID, RequiredArtifacts: cmd.RequiredArtifacts,
		MessageID:         wrap.Envelope.MessageID,
		TaskID:            cmd.TaskID,
		ExecutionID:       cmd.ExecutionID,
		TaskVersion:       cmd.TaskVersion,
		StorageGeneration: cmd.StorageGeneration,
		QueueExpiresAt:    expires,
		AgentType:         cmd.AgentType,
		TargetSessionID:   cmd.TargetSessionID,
		WorkingDirectory:  cmd.WorkingDirectory,
		Capabilities:      caps,
	}, func(sessionID string) error {
		if host == nil {
			return nil
		}
		known, err := ledger.HasWorker(sessionID)
		if err != nil {
			return err
		}
		if known {
			path, err := session.LedgerPath(host.DataDir, sessionID)
			if err != nil {
				return err
			}
			inspectErr := session.InspectLedger(path)
			if errors.Is(inspectErr, session.ErrHistoryMissing) || errors.Is(inspectErr, session.ErrHistoryIncompatible) {
				pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
				reachable := host.Reachable(pingCtx, sessionID)
				cancel()
				if !reachable {
					log.Info("event=prepare_history_unreadable", "session_id", sessionID, "reason", inspectErr.Error())
					return errHistoryUnreadable
				}
			} else if inspectErr != nil {
				return inspectErr
			}
		}
		bindCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		pid, err := host.Bind(bindCtx, sessionID, cmd.TaskID, cmd.ExecutionID, cmd.AgentType)
		if err != nil {
			return err
		}
		return ledger.RememberWorker(sessionID, pid)
	})
	if report.Silent {
		log.Info("event=prepare_not_acked", "task_id", cmd.TaskID)
		return true
	}
	if report.OK && ledger.ensureAgentContext(report) != nil {
		log.Info("event=agent_context_failed", "task_id", report.TaskID)
		return true
	}
	if report.OK {
		log.Info("event=prepare_acked", "task_id", report.TaskID, "session_id", report.SessionID)
	} else {
		log.Info("event=prepare_rejected", "task_id", cmd.TaskID, "code", report.Code)
	}
	writePrepareResult(ctx, w, wrap.Envelope.MessageID, report)
	if report.OK {
		loop.afterPrepare(report)
	}
	return true
}

func writePrepareResult(ctx context.Context, w *wsWriter, correlation string, report PrepareReport) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return
	}
	body, err := json.Marshal(protocol.PrepareResult{
		Type:              protocol.BodyPrepareResult,
		OK:                report.OK,
		Code:              report.Code,
		Message:           report.Message,
		TaskID:            report.TaskID,
		ExecutionID:       report.ExecutionID,
		SessionID:         report.SessionID,
		StorageGeneration: report.StorageGeneration,
	})
	if err != nil {
		return
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:       protocol.Version,
		MessageID:     messageID,
		Route:         protocol.Route{To: protocol.ToControl},
		Priority:      protocol.PriorityControl,
		CorrelationID: correlation,
		Body:          body,
	})
	if err != nil || len(env) > protocol.MaxMessageBytes {
		return
	}
	frame, err := json.Marshal(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		return
	}
	_ = w.write(ctx, frame)
}
