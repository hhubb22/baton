// Package control 实现 Coordinator 与 Relay 之间的认证控制连接。
package control

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"

	"github.com/coder/websocket"
)

// Server 在独立监听器上接受 Relay。节点凭据不能打开这条连接。
type Server struct {
	store     *store.Store
	signer    node.Signer
	public    ed25519.PublicKey
	tokenHash [32]byte
	heartbeat time.Duration
	offline   time.Duration
	log       *slog.Logger

	writeMu  sync.Mutex
	mu       sync.Mutex
	link     *controlLink
	pending  map[string]chan prepareNotice
	fileWait map[string]chan fileNotice
}

func New(st *store.Store, signer node.Signer, token string, heartbeat, offline time.Duration, log *slog.Logger) (*Server, error) {
	pub, err := signer.PublicKey()
	if err != nil {
		return nil, err
	}
	if len(token) < 20 || heartbeat <= 0 || offline <= heartbeat {
		return nil, errors.New("控制连接配置无效")
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Server{
		store:     st,
		signer:    signer,
		public:    pub,
		tokenHash: sha256.Sum256([]byte(token)),
		heartbeat: heartbeat,
		offline:   offline,
		log:       log,
		pending:   map[string]chan prepareNotice{},
		fileWait:  map[string]chan fileNotice{},
	}, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != protocol.ControlPath {
		http.NotFound(w, r)
		return
	}
	if !s.authorized(r.Header.Get("Authorization")) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("unauthorized\n"))
		return
	}
	// 控制连接由内部凭据认证，不是浏览器页面，不检查 Origin。
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(protocol.MaxMessageBytes)
	link := s.bind(ws)
	s.log.Info("event=control_connected")
	defer func() {
		s.unbind(link)
		ws.Close(websocket.StatusNormalClosure, "")
		s.log.Info("event=control_disconnected")
	}()
	if err := s.writeSnapshot(r.Context(), link); err != nil {
		s.log.Info("event=snapshot_failed")
		return
	}
	s.markReady(link)
	s.read(r.Context(), link)
}

func (s *Server) authorized(header string) bool {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return false
	}
	sum := sha256.Sum256([]byte(header[len(prefix):]))
	return subtle.ConstantTimeCompare(sum[:], s.tokenHash[:]) == 1
}

func (s *Server) writeSnapshot(ctx context.Context, link *controlLink) error {
	creds, nodes, err := s.store.Revocations(ctx)
	if err != nil {
		return err
	}
	snapID, err := identity.NewUUID()
	if err != nil {
		return err
	}
	credIDs := make([]string, 0, len(creds))
	for _, item := range creds {
		if item.ID != "" {
			credIDs = append(credIDs, item.ID)
		}
	}
	s.mu.Lock()
	link.acks[snapID] = credIDs
	s.mu.Unlock()
	snap := protocol.Snapshot{
		ID:                 snapID,
		Version:            protocol.Version,
		IssuedAt:           time.Now().UTC(),
		PublicKey:          base64.RawURLEncoding.EncodeToString(s.public),
		Issuer:             node.Issuer,
		Audience:           node.NodeAudience,
		HeartbeatMS:        s.heartbeat.Milliseconds(),
		OfflineMS:          s.offline.Milliseconds(),
		RevokedCredentials: creds,
		RevokedNodes:       nodes,
	}
	if err := s.send(ctx, link.ws, protocol.Frame{Kind: protocol.KindSnapshot, Snapshot: &snap}); err != nil {
		s.dropAck(link, snapID)
		return err
	}
	return nil
}

func (s *Server) read(ctx context.Context, link *controlLink) {
	ws := link.ws
	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var frame protocol.Frame
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		switch frame.Kind {
		case protocol.KindSnapshotOK:
			s.completeAck(ctx, link, frame.CorrelationID)
			s.log.Info("event=snapshot_applied")
			if _, _, err := s.pushPending(ctx); err != nil {
				s.log.Error("event=revocation_dispatch_failed")
			}
		case protocol.KindSessions:
			if err := s.store.ApplySessions(ctx, frame.Sessions); err != nil {
				s.log.Error("event=sessions_failed")
				continue
			}
			if frame.Metrics != nil {
				s.log.Info("event=relay_metrics",
					"online_nodes", frame.Metrics.OnlineNodes,
					"connects", frame.Metrics.Connects,
					"disconnects", frame.Metrics.Disconnects,
					"forwards", frame.Metrics.Forwards,
					"rejects", frame.Metrics.Rejects,
				)
			}
		case protocol.KindPresence:
			if frame.Presence == nil {
				continue
			}
			if frame.Presence.Online {
				if err := s.store.UpsertPresence(ctx, *frame.Presence); err != nil {
					s.log.Error("event=presence_failed", "node_id", frame.Presence.NodeID)
				}
				continue
			}
			if err := s.store.MarkOffline(ctx, frame.Presence.NodeID, frame.Presence.ConnID, time.Now()); err != nil {
				s.log.Error("event=presence_failed", "node_id", frame.Presence.NodeID)
			}
		case protocol.KindEnvelope:
			s.onEnvelope(ctx, ws, frame.Envelope)
		case protocol.KindRevokeOK:
			s.completeAck(ctx, link, frame.CorrelationID)
			s.log.Info("event=revocation_acked", "revocation_id", frame.CorrelationID)
		case protocol.KindError:
			s.notePrepareTransport(frame.CorrelationID, frame.Code)
			s.noteFileTransport(frame.CorrelationID, frame.Code)
			s.log.Info("event=relay_error", "code", frame.Code)
		}
	}
}

func (s *Server) onEnvelope(ctx context.Context, ws *websocket.Conn, raw json.RawMessage) {
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil || env.Source == nil || env.Source.Kind != protocol.SourceNode {
		_ = s.writeControlError(ctx, ws, protocol.CodeInvalidMessage, "")
		return
	}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(env.Body, &kind); err != nil {
		s.reply(ctx, ws, env, false, protocol.CodeInvalidMessage)
		return
	}
	switch kind.Type {
	case protocol.BodyAgentRequest:
		s.onAgentRequest(ctx, ws, env)
		return
	case protocol.BodyExecutionControl:
		s.onExecutionControl(ctx, ws, env)
		return
	case protocol.BodyPrepareResult:
		s.notePrepareResult(env)
		return
	case protocol.BodyStartPermit:
		s.onStartPermit(ctx, ws, env)
		return
	case protocol.BodyStartReport:
		s.onStartReport(ctx, ws, env)
		return
	case protocol.BodyExecutionInput:
		s.onExecutionInput(ctx, ws, env)
		return
	case protocol.BodyExecutionReport:
		s.onExecutionReport(ctx, ws, env)
		return
	}
	if kind.Type == protocol.BodyFileResult {
		s.noteFileResult(env)
		return
	}
	if kind.Type != "node.sync" {
		s.reply(ctx, ws, env, false, protocol.CodeInvalidMessage)
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
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || body.Type != "node.sync" {
		s.reply(ctx, ws, env, false, protocol.CodeInvalidMessage)
		return
	}
	err := s.store.SyncNode(ctx, env.Source.EmployeeID, env.Source.NodeID, env.Source.ConnID, body.DisplayName, body.System, body.Role, body.Capabilities)
	if err != nil {
		code := protocol.CodeSyncRejected
		s.log.Info("event=sync_rejected", "node_id", env.Source.NodeID, "code", code)
		s.reply(ctx, ws, env, false, code)
		return
	}
	s.log.Info("event=synced", "node_id", env.Source.NodeID, "employee_id", env.Source.EmployeeID)
	s.reply(ctx, ws, env, true, "")
}

func (s *Server) reply(ctx context.Context, ws *websocket.Conn, req protocol.Envelope, ok bool, code string) {
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
	_ = s.send(ctx, ws, protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env})
}

func (s *Server) writeControlError(ctx context.Context, ws *websocket.Conn, code, correlation string) error {
	return s.send(ctx, ws, protocol.Frame{
		Kind:          protocol.KindError,
		Code:          code,
		Message:       protocol.MessageOf(code),
		CorrelationID: correlation,
	})
}

func writeFrame(ctx context.Context, ws *websocket.Conn, frame protocol.Frame) error {
	raw, err := json.Marshal(frame)
	if err != nil || len(raw) > protocol.MaxMessageBytes {
		return protocol.ErrTooLarge
	}
	timer := time.AfterFunc(10*time.Second, func() {
		ws.Close(websocket.StatusGoingAway, "")
	})
	defer timer.Stop()
	return ws.Write(ctx, websocket.MessageText, raw)
}

func rawBody(body json.RawMessage) []byte {
	if len(body) == 0 {
		return []byte("null")
	}
	return body
}
