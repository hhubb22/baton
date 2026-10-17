// Package relay 接受节点的出站 TLS WebSocket，并把已认证流量转给 Coordinator。
package relay

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/redact"

	"github.com/coder/websocket"
)

// Options 是 Relay 的监听地址和 Coordinator 控制连接。
type Options struct {
	ListenAddr     string
	CoordinatorURL string
	ControlToken   string
	CertFile       string
	KeyFile        string
	RootCAs        *x509.CertPool
	Logger         *slog.Logger
}

// Relay 在拿到安全快照之前不接受节点连接。
type Relay struct {
	opts Options
	log  *slog.Logger
	root context.Context

	mu          sync.Mutex
	snap        *security
	nodes       map[string]*nodeConn
	pending     map[string]protocol.Presence
	business    *protocol.Queue
	haveControl bool
	listener    net.Listener
	httpSrv     *http.Server
	metrics     protocol.Metrics
	wake        chan struct{}
	ctrlWrite   sync.Mutex
}

type security struct {
	public      ed25519.PublicKey
	offline     time.Duration
	revokedID   map[string]struct{}
	revokedNode map[string]struct{}
}

type nodeConn struct {
	id           string
	nodeID       string
	employeeID   string
	credentialID string
	incarnation  string
	ws           *websocket.Conn
	out          *protocol.Queue
	local        chan []byte
	last         time.Time
}

var errControlDown = errors.New("control_unavailable")

func New(opts Options) (*Relay, error) {
	if opts.ListenAddr == "" || opts.CoordinatorURL == "" || opts.ControlToken == "" || opts.CertFile == "" || opts.KeyFile == "" {
		return nil, errors.New("Relay 配置不完整")
	}
	if _, err := controlWebSocketURL(opts.CoordinatorURL); err != nil {
		return nil, err
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	return &Relay{
		opts:    opts,
		log:     opts.Logger,
		nodes:   map[string]*nodeConn{},
		pending: map[string]protocol.Presence{},
		wake:    make(chan struct{}, 1),
	}, nil
}

// NodeAddr 在安全快照应用并开始监听后返回节点地址。此前为空。
func (r *Relay) NodeAddr() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.listener == nil {
		return ""
	}
	return r.listener.Addr().String()
}

// Run 连接 Coordinator，并在进程退出前保持节点监听。
func (r *Relay) Run(ctx context.Context) error {
	r.root = ctx
	go r.sweep(ctx)
	attempt := 0
	for {
		if ctx.Err() != nil {
			r.shutdown()
			return nil
		}
		connected, err := r.serveControl(ctx)
		if ctx.Err() != nil {
			r.shutdown()
			return nil
		}
		if connected {
			attempt = 0
		}
		delay := node.BackoffDelay(attempt, nil)
		if !connected {
			attempt++
		}
		r.log.Info("event=control_retry", "error", errKind(err))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			r.shutdown()
			return nil
		case <-timer.C:
		}
	}
}

func (r *Relay) shutdown() {
	r.mu.Lock()
	srv := r.httpSrv
	nodes := make([]*nodeConn, 0, len(r.nodes))
	for _, nc := range r.nodes {
		nodes = append(nodes, nc)
	}
	r.mu.Unlock()
	if srv != nil {
		shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = srv.Shutdown(shutCtx)
		cancel()
	}
	for _, nc := range nodes {
		nc.ws.Close(websocket.StatusGoingAway, "")
	}
}

func (r *Relay) serveControl(ctx context.Context) (bool, error) {
	ws, err := r.dialControl(ctx)
	if err != nil {
		return false, err
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	ws.SetReadLimit(protocol.MaxMessageBytes)
	_, raw, err := ws.Read(ctx)
	if err != nil {
		return false, err
	}
	var frame protocol.Frame
	if err := json.Unmarshal(raw, &frame); err != nil || frame.Kind != protocol.KindSnapshot || frame.Snapshot == nil {
		return false, errors.New("安全快照无效")
	}
	if err := r.apply(*frame.Snapshot); err != nil {
		return false, err
	}
	if err := r.ensureListen(); err != nil {
		return false, err
	}
	r.log.Info("event=control_connected")
	defer r.log.Info("event=control_disconnected")
	defer r.dropControl()

	r.mu.Lock()
	r.business = protocol.NewQueue(protocol.MaxQueueMessages, protocol.MaxQueueBytes)
	r.haveControl = true
	r.pending = map[string]protocol.Presence{}
	sessions := r.sessionsLocked()
	metrics := r.metrics
	metrics.OnlineNodes = int64(len(r.nodes))
	r.mu.Unlock()

	if err := writeFrame(ctx, ws, protocol.Frame{Kind: protocol.KindSnapshotOK, CorrelationID: frame.Snapshot.ID}); err != nil {
		return true, err
	}
	if err := writeFrame(ctx, ws, protocol.Frame{Kind: protocol.KindSessions, Sessions: sessions, Metrics: &metrics}); err != nil {
		return true, err
	}
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	errc := make(chan error, 1)
	go func() {
		err := r.writeControl(readCtx, ws)
		cancel()
		errc <- err
	}()
	readErr := r.readControl(readCtx, ws)
	cancel()
	writeErr := <-errc
	if readErr != nil && ctx.Err() == nil {
		return true, readErr
	}
	return true, writeErr
}

func (r *Relay) dropControl() {
	r.mu.Lock()
	r.haveControl = false
	r.business = nil
	r.mu.Unlock()
}

func (r *Relay) dialControl(ctx context.Context) (*websocket.Conn, error) {
	target, err := controlWebSocketURL(r.opts.CoordinatorURL)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: r.opts.RootCAs},
	}}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+r.opts.ControlToken)
	ws, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPClient: client, HTTPHeader: header})
	return ws, err
}

func (r *Relay) apply(snap protocol.Snapshot) error {
	if snap.Version != protocol.Version || snap.Issuer != node.Issuer || snap.Audience != node.NodeAudience {
		return errors.New("安全快照无效")
	}
	raw, err := base64.RawURLEncoding.DecodeString(snap.PublicKey)
	if err != nil || len(raw) != ed25519.PublicKeySize || snap.OfflineMS <= snap.HeartbeatMS || snap.HeartbeatMS < 100 {
		return errors.New("安全快照无效")
	}
	next := &security{
		public:      ed25519.PublicKey(raw),
		offline:     time.Duration(snap.OfflineMS) * time.Millisecond,
		revokedID:   map[string]struct{}{},
		revokedNode: map[string]struct{}{},
	}
	for _, item := range snap.RevokedCredentials {
		if item.ID != "" {
			next.revokedID[item.ID] = struct{}{}
		}
	}
	for _, item := range snap.RevokedNodes {
		if item.ID != "" {
			next.revokedNode[item.ID] = struct{}{}
		}
	}
	r.publish(next)
	return nil
}

func (r *Relay) publish(next *security) {
	r.mu.Lock()
	r.snap = next
	drop := matchingLocked(r.nodes, next)
	r.mu.Unlock()
	closeConns(drop)
}

func (r *Relay) applyRevoke(notice protocol.RevokeNotice) error {
	r.mu.Lock()
	if r.snap == nil {
		r.mu.Unlock()
		return errors.New("安全快照无效")
	}
	next := &security{
		public:      r.snap.public,
		offline:     r.snap.offline,
		revokedID:   cloneSet(r.snap.revokedID),
		revokedNode: cloneSet(r.snap.revokedNode),
	}
	for _, item := range notice.Credentials {
		if item.ID != "" {
			next.revokedID[item.ID] = struct{}{}
		}
	}
	for _, item := range notice.Nodes {
		if item.ID != "" {
			next.revokedNode[item.ID] = struct{}{}
		}
	}
	r.snap = next
	drop := matchingLocked(r.nodes, next)
	r.mu.Unlock()
	closeConns(drop)
	return nil
}

func matchingLocked(nodes map[string]*nodeConn, sec *security) []*nodeConn {
	if sec == nil {
		return nil
	}
	var drop []*nodeConn
	for _, nc := range nodes {
		if _, ok := sec.revokedID[nc.credentialID]; ok {
			drop = append(drop, nc)
			continue
		}
		if _, ok := sec.revokedNode[nc.nodeID]; ok {
			drop = append(drop, nc)
		}
	}
	return drop
}

func closeConns(conns []*nodeConn) {
	for _, nc := range conns {
		nc.ws.Close(websocket.StatusPolicyViolation, "")
	}
}

func cloneSet(in map[string]struct{}) map[string]struct{} {
	out := make(map[string]struct{}, len(in))
	for key := range in {
		out[key] = struct{}{}
	}
	return out
}

func credentialAllowed(sec *security, credentialID, nodeID string) bool {
	if sec == nil {
		return false
	}
	if _, revoked := sec.revokedID[credentialID]; revoked {
		return false
	}
	if _, revoked := sec.revokedNode[nodeID]; revoked {
		return false
	}
	return true
}

func (r *Relay) ensureListen() error {
	r.mu.Lock()
	if r.listener != nil {
		r.mu.Unlock()
		return nil
	}
	ln, err := net.Listen("tcp", r.opts.ListenAddr)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	srv := &http.Server{
		Handler:           http.HandlerFunc(r.serveNode),
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    1 << 16,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	r.listener = ln
	r.httpSrv = srv
	r.mu.Unlock()
	go func() { _ = srv.ServeTLS(ln, r.opts.CertFile, r.opts.KeyFile) }()
	r.log.Info("event=listening", "kind", "node", "addr", ln.Addr().String())
	return nil
}

func (r *Relay) serveNode(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != protocol.NodePath {
		http.NotFound(w, req)
		return
	}
	ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(protocol.MaxMessageBytes)
	r.handleNode(ws)
}

func (r *Relay) handleNode(ws *websocket.Conn) {
	ctx := r.root
	if ctx == nil {
		ctx = context.Background()
	}
	// 取消 Read 的 context 会关掉这条连接，所以认证等待用关闭连接来结束，而不是取消 context。
	timer := time.AfterFunc(10*time.Second, func() {
		ws.Close(websocket.StatusPolicyViolation, "")
	})
	_, raw, err := ws.Read(ctx)
	timer.Stop()
	if err != nil {
		ws.Close(websocket.StatusPolicyViolation, "")
		return
	}
	var frame protocol.Frame
	if json.Unmarshal(raw, &frame) != nil || frame.Kind != protocol.KindAuth || frame.Token == "" {
		r.rejectNode(ws, protocol.CodeInvalidMessage, "")
		return
	}
	r.mu.Lock()
	snap := r.snap
	r.mu.Unlock()
	if snap == nil {
		r.rejectNode(ws, protocol.CodeInvalidCredential, "")
		return
	}
	claims, err := node.VerifyNodeToken(snap.public, frame.Token, time.Now())
	if err != nil {
		r.reject(protocol.CodeInvalidCredential)
		r.rejectNode(ws, protocol.CodeInvalidCredential, "")
		return
	}
	if !credentialAllowed(snap, claims.CredentialID, claims.NodeID) {
		r.reject(protocol.CodeInvalidCredential)
		r.rejectNode(ws, protocol.CodeInvalidCredential, "")
		return
	}
	if _, err := identity.ParseUUID(frame.Incarnation); err != nil {
		r.reject(protocol.CodeInvalidMessage)
		r.rejectNode(ws, protocol.CodeInvalidMessage, "")
		return
	}
	connID, err := identity.NewUUID()
	if err != nil {
		r.rejectNode(ws, protocol.CodeInvalidMessage, "")
		return
	}
	nc := &nodeConn{
		id: connID, nodeID: claims.NodeID, employeeID: claims.EmployeeID,
		credentialID: claims.CredentialID, incarnation: frame.Incarnation,
		ws: ws, out: protocol.NewQueue(protocol.MaxQueueMessages, protocol.MaxQueueBytes),
		local: make(chan []byte, 8), last: time.Now(),
	}
	var previous *nodeConn
	r.mu.Lock()
	if !credentialAllowed(r.snap, claims.CredentialID, claims.NodeID) {
		r.metrics.Rejects++
		r.mu.Unlock()
		r.log.Info("event=rejected", "code", protocol.CodeInvalidCredential)
		r.rejectNode(ws, protocol.CodeInvalidCredential, "")
		return
	}
	if current := r.nodes[claims.NodeID]; current != nil && current.incarnation != frame.Incarnation {
		r.metrics.Rejects++
		r.mu.Unlock()
		r.log.Info("event=incarnation_conflict", "node_id", claims.NodeID)
		r.rejectNode(ws, protocol.CodeIncarnationConflict, "")
		return
	} else if current != nil {
		previous = current
	}
	r.nodes[claims.NodeID] = nc
	r.metrics.Connects++
	online := r.haveControl
	if online {
		r.pending[claims.NodeID] = presenceOf(nc, true)
	}
	r.mu.Unlock()
	if err := writeFrame(ctx, ws, protocol.Frame{Kind: protocol.KindAuthResult, OK: true}); err != nil {
		r.mu.Lock()
		if r.nodes[claims.NodeID] == nc {
			if previous != nil {
				r.nodes[claims.NodeID] = previous
			} else {
				delete(r.nodes, claims.NodeID)
			}
			delete(r.pending, claims.NodeID)
		}
		r.mu.Unlock()
		ws.Close(websocket.StatusInternalError, "")
		return
	}
	if previous != nil {
		previous.ws.Close(websocket.StatusGoingAway, "")
	}
	r.wakeLocked()
	r.log.Info("event=node_connected", "node_id", nc.nodeID, "conn_id", nc.id)
	nodeCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		r.writeNode(nodeCtx, nc)
		nc.ws.Close(websocket.StatusGoingAway, "")
	}()
	r.readNode(ctx, nc)
	stop()
	r.finish(nc)
	ws.Close(websocket.StatusNormalClosure, "")
}

func (r *Relay) readNode(ctx context.Context, nc *nodeConn) {
	for {
		_, raw, err := nc.ws.Read(ctx)
		if err != nil {
			return
		}
		var frame protocol.Frame
		if json.Unmarshal(raw, &frame) != nil {
			r.localError(nc, protocol.CodeInvalidMessage, "")
			continue
		}
		r.touch(nc)
		switch frame.Kind {
		case protocol.KindHeartbeat:
		case protocol.KindEnvelope:
			prepared, err := protocol.PrepareNodeEnvelope(frame.Envelope, protocol.Source{
				NodeID: nc.nodeID, EmployeeID: nc.employeeID, CredentialID: nc.credentialID,
				Incarnation: nc.incarnation, ConnID: nc.id,
			})
			if err != nil {
				r.reject(protocol.CodeOf(err))
				r.localError(nc, protocol.CodeOf(err), "")
				continue
			}
			out, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: prepared})
			if err != nil || len(out) > protocol.MaxMessageBytes {
				r.reject(protocol.CodeMessageTooLarge)
				r.localError(nc, protocol.CodeMessageTooLarge, "")
				continue
			}
			if err := r.enqueueControl(out); err != nil {
				code := protocol.CodeControlUnavailable
				if errors.Is(err, protocol.ErrQueueFull) || errors.Is(err, protocol.ErrTooLarge) {
					code = protocol.CodeOf(err)
				}
				r.reject(code)
				r.localError(nc, code, "")
				continue
			}
			r.countForward()
		default:
			r.localError(nc, protocol.CodeInvalidMessage, "")
		}
	}
}

func (r *Relay) writeNode(ctx context.Context, nc *nodeConn) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case raw := <-nc.local:
			if writeRaw(ctx, nc.ws, raw) != nil {
				return
			}
		case <-ticker.C:
			for i := 0; i < 8; i++ {
				raw, ok := nc.out.TryPop()
				if !ok {
					break
				}
				if writeRaw(ctx, nc.ws, raw) != nil {
					return
				}
			}
		}
	}
}

func (r *Relay) readControl(ctx context.Context, ws *websocket.Conn) error {
	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		var frame protocol.Frame
		if json.Unmarshal(raw, &frame) != nil {
			continue
		}
		switch frame.Kind {
		case protocol.KindEnvelope:
			r.deliverControl(frame.Envelope)
		case protocol.KindSnapshot:
			if frame.Snapshot != nil {
				_ = r.apply(*frame.Snapshot)
			}
		case protocol.KindRevoke:
			if frame.Revoke == nil || frame.Revoke.ID == "" {
				continue
			}
			if err := r.applyRevoke(*frame.Revoke); err != nil {
				r.log.Info("event=revocation_rejected")
				continue
			}
			r.log.Info("event=revocation_applied", "revocation_id", frame.Revoke.ID)
			if err := r.writeControlFrame(ctx, ws, protocol.Frame{Kind: protocol.KindRevokeOK, CorrelationID: frame.Revoke.ID}); err != nil {
				return err
			}
		}
	}
}

func (r *Relay) deliverControl(raw json.RawMessage) {
	messageID := protocol.MessageID(raw)
	nodeID, prepared, err := protocol.PrepareControlEnvelope(raw)
	if err != nil {
		r.reject(protocol.CodeOf(err))
		r.controlError(protocol.CodeOf(err), messageID)
		return
	}
	out, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: prepared})
	if err != nil || len(out) > protocol.MaxMessageBytes {
		r.reject(protocol.CodeMessageTooLarge)
		r.controlError(protocol.CodeMessageTooLarge, messageID)
		return
	}
	r.mu.Lock()
	nc := r.nodes[nodeID]
	r.mu.Unlock()
	if nc == nil {
		r.reject(protocol.CodeNodeUnavailable)
		r.controlError(protocol.CodeNodeUnavailable, messageID)
		return
	}
	if err := nc.out.Push(out); err != nil {
		r.reject(protocol.CodeOf(err))
		r.controlError(protocol.CodeOf(err), messageID)
		return
	}
	r.countForward()
}

func (r *Relay) writeControl(ctx context.Context, ws *websocket.Conn) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.wake:
		case <-ticker.C:
		}
		if err := r.flush(ctx, ws); err != nil {
			return err
		}
	}
}

func (r *Relay) flush(ctx context.Context, ws *websocket.Conn) error {
	r.mu.Lock()
	pending := r.pending
	r.pending = map[string]protocol.Presence{}
	q := r.business
	r.mu.Unlock()
	for _, item := range pending {
		copied := item
		if err := r.writeControlFrame(ctx, ws, protocol.Frame{Kind: protocol.KindPresence, Presence: &copied}); err != nil {
			r.restore(pending)
			return err
		}
	}
	if q == nil {
		return nil
	}
	for i := 0; i < 8; i++ {
		raw, ok := q.TryPop()
		if !ok {
			return nil
		}
		if err := r.writeControlRaw(ctx, ws, raw); err != nil {
			return err
		}
	}
	return nil
}

func (r *Relay) writeControlFrame(ctx context.Context, ws *websocket.Conn, frame protocol.Frame) error {
	r.ctrlWrite.Lock()
	defer r.ctrlWrite.Unlock()
	return writeFrame(ctx, ws, frame)
}

func (r *Relay) writeControlRaw(ctx context.Context, ws *websocket.Conn, raw []byte) error {
	r.ctrlWrite.Lock()
	defer r.ctrlWrite.Unlock()
	return writeRaw(ctx, ws, raw)
}

func (r *Relay) restore(pending map[string]protocol.Presence) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.haveControl {
		return
	}
	for id, item := range pending {
		if _, exists := r.pending[id]; !exists {
			r.pending[id] = item
		}
	}
}

func (r *Relay) enqueueControl(raw []byte) error {
	r.mu.Lock()
	q := r.business
	up := r.haveControl
	r.mu.Unlock()
	if !up || q == nil {
		return errControlDown
	}
	if err := q.Push(raw); err != nil {
		return err
	}
	r.wakeLocked()
	return nil
}

func (r *Relay) touch(nc *nodeConn) {
	r.mu.Lock()
	nc.last = time.Now()
	if current := r.nodes[nc.nodeID]; current == nc && r.haveControl {
		r.pending[nc.nodeID] = presenceOf(nc, true)
	}
	r.mu.Unlock()
	r.wakeLocked()
}

func (r *Relay) finish(nc *nodeConn) {
	r.mu.Lock()
	current := r.nodes[nc.nodeID] == nc
	if current {
		delete(r.nodes, nc.nodeID)
		r.metrics.Disconnects++
		if r.haveControl {
			r.pending[nc.nodeID] = presenceOf(nc, false)
		}
	}
	r.mu.Unlock()
	if current {
		r.log.Info("event=node_disconnected", "node_id", nc.nodeID, "conn_id", nc.id)
		r.wakeLocked()
	}
}

func (r *Relay) sweep(ctx context.Context) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.sweepOnce()
		}
	}
}

func (r *Relay) sweepOnce() {
	r.mu.Lock()
	offline := 30 * time.Second
	if r.snap != nil {
		offline = r.snap.offline
	}
	now := time.Now()
	var stale []*nodeConn
	for _, nc := range r.nodes {
		if now.Sub(nc.last) > offline {
			stale = append(stale, nc)
		}
	}
	r.mu.Unlock()
	for _, nc := range stale {
		nc.ws.Close(websocket.StatusGoingAway, "offline")
	}
}

func (r *Relay) sessionsLocked() []protocol.Presence {
	out := make([]protocol.Presence, 0, len(r.nodes))
	for _, nc := range r.nodes {
		out = append(out, presenceOf(nc, true))
	}
	return out
}

func (r *Relay) localError(nc *nodeConn, code, correlation string) {
	raw, err := json.Marshal(protocol.Frame{
		Kind: protocol.KindError, Code: code, Message: protocol.MessageOf(code), CorrelationID: correlation,
	})
	if err != nil {
		return
	}
	select {
	case nc.local <- raw:
	default:
	}
}

func (r *Relay) controlError(code, correlation string) {
	raw, err := json.Marshal(protocol.Frame{
		Kind: protocol.KindError, Code: code, Message: protocol.MessageOf(code), CorrelationID: correlation,
	})
	if err != nil {
		return
	}
	_ = r.enqueueControl(raw)
}

func (r *Relay) reject(code string) {
	r.mu.Lock()
	r.metrics.Rejects++
	r.mu.Unlock()
	r.log.Info("event=rejected", "code", code)
}

func (r *Relay) countForward() {
	r.mu.Lock()
	r.metrics.Forwards++
	r.mu.Unlock()
}

func (r *Relay) wakeLocked() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *Relay) rejectNode(ws *websocket.Conn, code, _ string) {
	_ = writeFrame(context.Background(), ws, protocol.Frame{Kind: protocol.KindAuthResult, OK: false, Code: code, Message: protocol.MessageOf(code)})
	ws.Close(websocket.StatusPolicyViolation, "")
}

func presenceOf(nc *nodeConn, online bool) protocol.Presence {
	now := time.Now().UTC()
	return protocol.Presence{
		NodeID: nc.nodeID, EmployeeID: nc.employeeID, CredentialID: nc.credentialID,
		Incarnation: nc.incarnation, ConnID: nc.id, Online: online, LastContact: now,
	}
}

func writeFrame(ctx context.Context, ws *websocket.Conn, frame protocol.Frame) error {
	raw, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return writeRaw(ctx, ws, raw)
}

func writeRaw(ctx context.Context, ws *websocket.Conn, raw []byte) error {
	if len(raw) > protocol.MaxMessageBytes {
		return protocol.ErrTooLarge
	}
	// Write 使用的 context 被取消时会关闭连接。超时改为直接关闭，避免短超时在成功写入后把连接拆掉。
	timer := time.AfterFunc(10*time.Second, func() {
		ws.Close(websocket.StatusGoingAway, "")
	})
	defer timer.Stop()
	return ws.Write(ctx, websocket.MessageText, raw)
}

func controlWebSocketURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("Coordinator 地址无效")
	}
	if u.Scheme != "https" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("Coordinator 地址无效")
	}
	u.Scheme = "wss"
	u.Path = protocol.ControlPath
	return u.String(), nil
}

func errKind(err error) string {
	if err == nil {
		return ""
	}
	text := redact.Scrub(err.Error())
	if len(text) > 120 {
		text = text[:120]
	}
	return text
}
