// Package control 实现 Coordinator 的节点业务处理与授权。
package control

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"baton/internal/gateway"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
)

type Server struct {
	store          *store.Store
	signer         node.Signer
	public         ed25519.PublicKey
	log            *slog.Logger
	sender         gateway.Sender
	mu             sync.Mutex
	pending        map[string]chan prepareNotice
	fileWait       map[string]chan fileNotice
	sessionWaiters map[string]chan sessionNotice
	budget         *protocol.Budget
}

func New(st *store.Store, signer node.Signer, log *slog.Logger, budgets ...*protocol.Budget) (*Server, error) {
	budget := protocol.NewBudget(protocol.MaxOutputCacheBytes)
	if len(budgets) > 0 && budgets[0] != nil {
		budget = budgets[0]
	}
	pub, err := signer.PublicKey()
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Server{budget: budget, store: st, signer: signer, public: pub, log: log, pending: map[string]chan prepareNotice{}, fileWait: map[string]chan fileNotice{}}, nil
}

// SetSender 在开放监听前设置一次，业务层不持有传输连接。
func (s *Server) SetSender(sender gateway.Sender) { s.sender = sender }

func (s *Server) Authenticate(ctx context.Context, token string) (protocol.Source, error) {
	claims, err := node.VerifyNodeToken(s.public, token, time.Now())
	if err != nil {
		return protocol.Source{}, gateway.ErrInvalidCredential
	}
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: claims.EmployeeID, NodeID: claims.NodeID, CredentialID: claims.CredentialID}
	if err = s.store.CheckNodeConnection(ctx, src, false, false); err != nil {
		if errors.Is(err, store.ErrSyncRejected) {
			return protocol.Source{}, gateway.ErrInvalidCredential
		}
		return protocol.Source{}, err
	}
	return src, nil
}

func (s *Server) Connected(ctx context.Context, src protocol.Source) error {
	err := s.store.ConnectNode(ctx, src)
	if errors.Is(err, store.ErrSyncRejected) {
		return gateway.ErrInvalidCredential
	}
	return err
}
func (s *Server) Disconnected(ctx context.Context, src protocol.Source) {
	if err := s.store.MarkOffline(ctx, src.NodeID, src.ConnID, time.Now()); err != nil {
		s.log.Info("event=presence_failed", "node_id", src.NodeID)
	}
}
func (s *Server) Heartbeat(ctx context.Context, src protocol.Source) error {
	return s.store.TouchNode(ctx, src)
}

func (s *Server) Handle(ctx context.Context, src protocol.Source, env protocol.Envelope) error {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(env.Body, &head) != nil {
		return protocol.ErrInvalidMessage
	}
	if err := s.store.CheckNodeConnection(ctx, src, true, head.Type != "node.sync"); err != nil {
		return err
	}
	env.Source = &src
	raw, err := protocol.MarshalJSON(env)
	if err != nil {
		return err
	}
	s.onEnvelope(ctx, src.ConnID, raw)
	return nil
}

func (s *Server) onEnvelope(ctx context.Context, connID string, raw json.RawMessage) {
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil || env.Source == nil || env.Source.Kind != protocol.SourceNode {
		_ = s.writeControlError(ctx, connID, protocol.CodeInvalidMessage, "")
		return
	}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(env.Body, &kind); err != nil {
		s.reply(ctx, connID, env, false, protocol.CodeInvalidMessage)
		return
	}
	switch kind.Type {
	case protocol.BodyProjectRuntimeRequest:
		s.onProjectRuntimeRequest(ctx, connID, env)
		return
	case protocol.BodyRuntimeReport:
		s.onRuntimeReport(ctx, connID, env)
		return
	case protocol.BodySessionResult:
		s.noteSessionResult(env)
		return
	case protocol.BodyAgentRequest:
		s.onAgentRequest(ctx, connID, env)
		return
	case protocol.BodyExecutionControl:
		s.onExecutionControl(ctx, connID, env)
		return
	case protocol.BodyChildDeliveries, protocol.BodyChildDeliveryAck:
		s.onChildDelivery(ctx, connID, env)
		return
	case protocol.BodyPrepareResult:
		s.notePrepareResult(env)
		return
	case protocol.BodyStartPermit:
		s.onStartPermit(ctx, connID, env)
		return
	case protocol.BodyStartReport:
		s.onStartReport(ctx, connID, env)
		return
	case protocol.BodyExecutionInput:
		s.onExecutionInput(ctx, connID, env)
		return
	case protocol.BodyExecutionReport:
		s.onExecutionReport(ctx, connID, env)
		return
	}
	if kind.Type == protocol.BodyFileResult {
		s.noteFileResult(env)
		return
	}
	if kind.Type != "node.sync" {
		s.reply(ctx, connID, env, false, protocol.CodeInvalidMessage)
		return
	}
	var body struct {
		Type         string   `json:"type"`
		DisplayName  string   `json:"display_name"`
		System       string   `json:"system"`
		Role         string   `json:"role"`
		Capabilities []string `json:"capabilities"`
	}
	dec := json.NewDecoder(bytes.NewReader(rawBody(env.Body)))
	if err := dec.Decode(&body); err != nil || body.Type != "node.sync" {
		s.reply(ctx, connID, env, false, protocol.CodeInvalidMessage)
		return
	}
	err := s.store.SyncNode(ctx, env.Source.EmployeeID, env.Source.NodeID, env.Source.ConnID, body.DisplayName, body.System, body.Role, body.Capabilities)
	if err != nil {
		code := protocol.CodeSyncRejected
		s.log.Info("event=sync_rejected", "node_id", env.Source.NodeID, "code", code)
		s.reply(ctx, connID, env, false, code)
		return
	}
	s.log.Info("event=synced", "node_id", env.Source.NodeID, "employee_id", env.Source.EmployeeID)
	s.reply(ctx, connID, env, true, "")
}

func (s *Server) reply(ctx context.Context, connID string, req protocol.Envelope, ok bool, code string) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return
	}
	body, err := json.Marshal(struct {
		Type string `json:"type"`
		OK   bool   `json:"ok"`
		Code string `json:"code,omitempty"`
	}{Type: "node.sync_result", OK: ok, Code: code})
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

func (s *Server) writeControlError(ctx context.Context, connID string, code, correlation string) error {
	return s.send(ctx, connID, protocol.Frame{
		Kind:          protocol.KindError,
		Code:          code,
		Message:       protocol.MessageOf(code),
		CorrelationID: correlation,
	})
}

func rawBody(body json.RawMessage) []byte {
	if len(body) == 0 {
		return []byte("null")
	}
	return body
}
