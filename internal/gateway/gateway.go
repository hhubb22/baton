// Package gateway 管理 Coordinator 的节点连接和有界消息调度。
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"github.com/coder/websocket"
)

// Authenticator 在业务层验签并查询权威凭据状态。
type Authenticator interface {
	Authenticate(context.Context, string) (protocol.Source, error)
}

// Handler 接收认证来源；生命周期更新与业务分派均在 socket 读循环之外执行。
type Handler interface {
	Connected(context.Context, protocol.Source) error
	Disconnected(context.Context, protocol.Source)
	Heartbeat(context.Context, protocol.Source) error
	Handle(context.Context, protocol.Source, protocol.Envelope) error
}

// Sender 的成功只表示消息进入有界队列。connID 非空时只允许原连接接收。
type Sender interface {
	Send(context.Context, string, string, protocol.Envelope) error
	DisconnectCredential(string)
}

const (
	MaxHandshakes     = 32
	MaxHandlers       = 16
	MaxNodes          = 128
	MaxOutputMessages = 16
	MaxOutputBytes    = 256 * 1024
)

var ErrUnavailable = errors.New("节点暂时不可达")
var ErrInvalidCredential = errors.New("节点凭据无效")

type Gateway struct {
	auth       Authenticator
	handler    Handler
	log        *slog.Logger
	offline    time.Duration
	mu         sync.Mutex
	nodes      map[string]*slot
	blocked    map[string]bool
	closed     bool
	handshakes chan struct{}
	jobs       chan struct{}
	wake       chan struct{}
	cursor     int
	budget     *protocol.Budget
}

type slot struct {
	// run 保证同一节点的连接登记、断开与业务处理有确定的先后顺序。
	run     sync.Mutex
	refs    int
	current *connection
}

type connection struct {
	source                      protocol.Source
	ws                          *websocket.Conn
	ctx                         context.Context
	cancel                      context.CancelFunc
	in, output, out, outOutput  *queue
	local                       chan []byte
	last                        time.Time
	dirty                       bool
	busy                        bool
	controls                    int
	rateAt                      time.Time
	controlTokens, outputTokens float64
	synced                      bool
	rpcControl                  map[string]time.Time
	syncIn                      *queue
}

func New(auth Authenticator, handler Handler, offline time.Duration, log *slog.Logger, budgets ...*protocol.Budget) *Gateway {
	budget := protocol.NewBudget(protocol.MaxOutputCacheBytes)
	if len(budgets) > 0 && budgets[0] != nil {
		budget = budgets[0]
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Gateway{auth: auth, handler: handler, offline: offline, log: log,
		budget: budget, nodes: map[string]*slot{}, blocked: map[string]bool{}, handshakes: make(chan struct{}, MaxHandshakes), jobs: make(chan struct{}, MaxHandlers), wake: make(chan struct{}, 1)}
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != protocol.NodePath {
		http.NotFound(w, r)
		return
	}
	select {
	case g.handshakes <- struct{}{}:
	default:
		http.Error(w, "节点认证繁忙", http.StatusServiceUnavailable)
		return
	}
	held := true
	defer func() {
		if held {
			<-g.handshakes
		}
	}()
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(protocol.MaxMessageBytes)
	timer := time.AfterFunc(10*time.Second, func() { ws.CloseNow() })
	defer timer.Stop()
	_, raw, err := ws.Read(r.Context())
	if err != nil {
		return
	}
	var frame protocol.Frame
	if json.Unmarshal(raw, &frame) != nil || frame.Kind != protocol.KindAuth || frame.Token == "" {
		g.reject(ws, protocol.CodeInvalidMessage)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	src, err := g.auth.Authenticate(ctx, frame.Token)
	cancel()
	if err != nil {
		if errors.Is(err, ErrInvalidCredential) {
			g.reject(ws, protocol.CodeInvalidCredential)
		}
		return
	}
	if _, err := identity.ParseUUID(frame.Incarnation); err != nil {
		g.reject(ws, protocol.CodeInvalidMessage)
		return
	}
	src.Kind = protocol.SourceNode
	src.Incarnation = frame.Incarnation
	src.ConnID, err = identity.NewUUID()
	if err != nil {
		return
	}
	g.mu.Lock()
	sl := g.nodes[src.NodeID]
	if g.closed || g.blocked[src.CredentialID] || (sl == nil && len(g.nodes) >= MaxNodes) {
		blocked := g.blocked[src.CredentialID]
		g.mu.Unlock()
		if blocked {
			g.reject(ws, protocol.CodeInvalidCredential)
		}
		return
	}
	if sl == nil {
		sl = &slot{}
		g.nodes[src.NodeID] = sl
	}
	sl.refs++
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		sl.refs--
		if sl.refs == 0 && sl.current == nil {
			delete(g.nodes, src.NodeID)
		}
		g.mu.Unlock()
	}()
	sl.run.Lock()
	g.mu.Lock()
	previous := sl.current
	blocked := g.blocked[src.CredentialID]
	allowed := !g.closed && !blocked
	conflict := previous != nil && previous.source.Incarnation != src.Incarnation
	g.mu.Unlock()
	if !allowed || conflict {
		sl.run.Unlock()
		if conflict {
			g.reject(ws, protocol.CodeIncarnationConflict)
		} else if blocked {
			g.reject(ws, protocol.CodeInvalidCredential)
		}
		return
	}
	// 再次读取数据库，覆盖认证到登记之间的吊销竞争。
	ctx, cancel = context.WithTimeout(r.Context(), 5*time.Second)
	_, err = g.auth.Authenticate(ctx, frame.Token)
	if err == nil {
		err = g.handler.Connected(ctx, src)
	}
	cancel()
	if err != nil {
		sl.run.Unlock()
		if errors.Is(err, ErrInvalidCredential) {
			g.reject(ws, protocol.CodeInvalidCredential)
		}
		return
	}
	nodeCtx, stop := context.WithCancel(r.Context())
	nc := &connection{rpcControl: map[string]time.Time{}, source: src, ws: ws, ctx: nodeCtx, cancel: stop,
		syncIn: newQueue(2, protocol.MaxQueueBytes), in: newQueue(protocol.MaxQueueMessages, protocol.MaxQueueBytes), output: newQueue(MaxOutputMessages, MaxOutputBytes),
		out: newQueue(protocol.MaxQueueMessages, protocol.MaxQueueBytes), outOutput: newQueue(MaxOutputMessages, MaxOutputBytes), local: make(chan []byte, 8), last: time.Now(), rateAt: time.Now(), controlTokens: 64, outputTokens: 128}
	nc.output.budget = g.budget
	nc.outOutput.budget = g.budget
	g.mu.Lock()
	blocked = g.blocked[src.CredentialID]
	allowed = !g.closed && !blocked
	if allowed {
		sl.current = nc
	}
	g.mu.Unlock()
	sl.run.Unlock()
	if !allowed {
		stop()
		g.handler.Disconnected(r.Context(), src)
		if blocked {
			g.reject(ws, protocol.CodeInvalidCredential)
		}
		return
	}
	if previous != nil {
		previous.cancel()
		previous.ws.CloseNow()
	}
	defer func() {
		stop()
		ws.CloseNow()
		nc.syncIn.discard()
		nc.in.discard()
		nc.output.discard()
		nc.out.discard()
		nc.outOutput.discard()
		sl.run.Lock()
		g.mu.Lock()
		if sl.current == nc {
			sl.current = nil
		}
		g.mu.Unlock()
		end, done := context.WithTimeout(context.Background(), 5*time.Second)
		g.handler.Disconnected(end, src)
		done()
		sl.run.Unlock()
		g.log.Info("event=node_disconnected", "node_id", src.NodeID, "conn_id", src.ConnID)
	}()
	timer.Stop()
	if writeFrame(nodeCtx, ws, protocol.Frame{Kind: protocol.KindAuthResult, OK: true}) != nil {
		return
	}
	<-g.handshakes
	held = false
	g.log.Info("event=node_connected", "node_id", src.NodeID, "conn_id", src.ConnID)
	go func() { g.writeNode(nc); stop(); ws.CloseNow() }()
	g.readNode(nc)
}

func (g *Gateway) readNode(nc *connection) {
	for {
		_, raw, err := nc.ws.Read(nc.ctx)
		if err != nil {
			return
		}
		var f protocol.Frame
		if json.Unmarshal(raw, &f) != nil {
			g.localError(nc, protocol.CodeInvalidMessage, "")
			continue
		}
		g.mu.Lock()
		nc.last = time.Now()
		g.mu.Unlock()
		if f.Kind == protocol.KindHeartbeat {
			g.mu.Lock()
			nc.dirty = true
			g.mu.Unlock()
			g.wakeUp()
			continue
		}
		if f.Kind != protocol.KindEnvelope {
			g.localError(nc, protocol.CodeInvalidMessage, "")
			continue
		}
		raw, err = protocol.PrepareNodeEnvelope(f.Envelope, nc.source)
		if err != nil {
			g.localError(nc, protocol.CodeOf(err), protocol.MessageID(f.Envelope))
			continue
		}
		var env protocol.Envelope
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		priority, err := incomingPriority(env.Body)
		if err != nil {
			g.localError(nc, protocol.CodeInvalidMessage, env.MessageID)
			continue
		}
		g.mu.Lock()
		if until, known := nc.rpcControl[env.CorrelationID]; known && until.After(time.Now()) {
			priority = protocol.PriorityControl
		}
		for id, until := range nc.rpcControl {
			if until.Before(time.Now()) {
				delete(nc.rpcControl, id)
			}
		}
		g.mu.Unlock()
		env.Priority = priority
		raw, err = json.Marshal(env)
		if err != nil {
			continue
		}
		g.mu.Lock()
		elapsed := time.Since(nc.rateAt).Seconds()
		nc.rateAt = time.Now()
		nc.controlTokens = min(64, nc.controlTokens+elapsed*64)
		nc.outputTokens = min(128, nc.outputTokens+elapsed*128)
		tokens := &nc.controlTokens
		q := nc.in
		var bodyHead struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(env.Body, &bodyHead)
		if bodyHead.Type == "node.sync" {
			q = nc.syncIn
		}
		if priority == protocol.PriorityOutput {
			tokens = &nc.outputTokens
			q = nc.output
		}
		limited := *tokens < 1
		if !limited {
			*tokens--
		}
		g.mu.Unlock()
		if limited {
			g.localError(nc, protocol.CodeQueueFull, env.MessageID)
			continue
		}
		if err = q.Push(raw); err != nil {
			g.localError(nc, protocol.CodeOf(err), env.MessageID)
			continue
		}
		g.mu.Lock()
		delete(nc.rpcControl, env.CorrelationID)
		g.mu.Unlock()
		g.wakeUp()
	}
}

// incomingPriority 根据已知类型分类，节点自报优先级不参与调度。
func incomingPriority(body json.RawMessage) (string, error) {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(body, &head) != nil {
		return "", protocol.ErrInvalidMessage
	}
	switch head.Type {
	case protocol.BodyRuntimeReport:
		return protocol.PriorityControl, nil
	case "node.sync", protocol.BodyAgentRequest, protocol.BodyExecutionControl, protocol.BodyChildDeliveries, protocol.BodyChildDeliveryAck, protocol.BodyPrepareResult, protocol.BodyStartPermit, protocol.BodyStartReport, protocol.BodyExecutionInput, protocol.BodyExecutionReport, protocol.BodyFileResult:
		return protocol.PriorityControl, nil
	case protocol.BodySessionResult:
		return protocol.PriorityOutput, nil
	default:
		return "", protocol.ErrInvalidMessage
	}
}

// Run 轮转节点，每节点只允许一个在途业务处理，最多并行 MaxHandlers 个。
func (g *Gateway) Run(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			g.Close()
			return
		case <-g.wake:
		case <-ticker.C:
		}
		g.schedule()
	}
}

func (g *Gateway) schedule() {
	g.mu.Lock()
	ids := make([]string, 0, len(g.nodes))
	for id := range g.nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) == 0 {
		g.mu.Unlock()
		return
	}
	start := g.cursor % len(ids)
	for offset := 0; offset < len(ids); offset++ {
		sl := g.nodes[ids[(start+offset)%len(ids)]]
		g.cursor = (start + offset + 1) % len(ids)

		nc := sl.current
		if nc == nil || nc.busy || nc.ctx.Err() != nil || g.blocked[nc.source.CredentialID] {
			continue
		}
		if time.Since(nc.last) > g.offline {
			nc.cancel()
			nc.ws.CloseNow()
			continue
		}
		select {
		case g.jobs <- struct{}{}:
		default:
			g.cursor = (start + offset) % len(ids)
			g.mu.Unlock()
			return
		}
		var raw []byte
		var ok bool
		release := func() {}
		raw, release, ok = nc.syncIn.take()
		if !ok && nc.synced && nc.controls < 8 {
			raw, release, ok = nc.in.take()
		}
		if !ok && nc.synced {
			raw, release, ok = nc.output.take()
			if ok {
				nc.controls = 0
			}
		}
		if !ok && nc.synced {
			raw, release, ok = nc.in.take()
		}
		if !ok && !nc.dirty {
			<-g.jobs
			continue
		}
		nc.busy = true
		nc.controls++
		heartbeat := nc.dirty
		nc.dirty = false
		go g.dispatch(sl, nc, raw, heartbeat, release)
	}
	g.mu.Unlock()
}

func (g *Gateway) dispatch(sl *slot, nc *connection, raw []byte, heartbeat bool, release func()) {
	defer release()
	defer func() { g.mu.Lock(); nc.busy = false; g.mu.Unlock(); <-g.jobs; g.wakeUp() }()
	sl.run.Lock()
	defer sl.run.Unlock()
	g.mu.Lock()
	valid := sl.current == nc && !g.closed && !g.blocked[nc.source.CredentialID]
	g.mu.Unlock()
	if !valid || nc.ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(nc.ctx, 5*time.Second)
	defer cancel()
	if heartbeat {
		if g.handler.Heartbeat(ctx, nc.source) != nil {
			nc.cancel()
			nc.ws.CloseNow()
			return
		}
	}
	if len(raw) > 0 {
		var env protocol.Envelope
		if json.Unmarshal(raw, &env) == nil {
			if err := g.handler.Handle(ctx, nc.source, env); err != nil {
				nc.cancel()
				nc.ws.CloseNow()
			}
		}
	}
}

func (g *Gateway) Send(ctx context.Context, nodeID, connID string, env protocol.Envelope) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	_, raw, err = protocol.PrepareControlEnvelope(raw)
	if err != nil {
		return err
	}
	raw, err = json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: raw})
	if err != nil || len(raw) > protocol.MaxMessageBytes {
		return protocol.ErrTooLarge
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	sl := g.nodes[nodeID]
	if sl == nil || sl.current == nil || g.closed {
		return ErrUnavailable
	}
	nc := sl.current
	if nc.ctx.Err() != nil || g.blocked[nc.source.CredentialID] || (connID != "" && connID != nc.source.ConnID) {
		return ErrUnavailable
	}
	var head struct {
		Type   string `json:"type"`
		OK     bool   `json:"ok"`
		Action string `json:"action"`
	}
	if json.Unmarshal(env.Body, &head) != nil {
		return protocol.ErrInvalidMessage
	}
	if head.Type == "node.sync_result" && connID != "" && head.OK {
		nc.synced = true
	}
	if !nc.synced && head.Type != "node.sync_result" {
		return ErrUnavailable
	}
	if head.Type == protocol.BodySessionRequest && (head.Action == "output" || head.Action == "history") {
		return nc.outOutput.Push(raw)
	}
	if head.Type == protocol.BodySessionRequest {
		for id, until := range nc.rpcControl {
			if until.Before(time.Now()) {
				delete(nc.rpcControl, id)
			}
		}
		if len(nc.rpcControl) >= 128 {
			return protocol.ErrQueueFull
		}
		if err := nc.out.Push(raw); err != nil {
			return err
		}
		nc.rpcControl[env.MessageID] = time.Now().Add(15 * time.Second)
		return nil
	}
	return nc.out.Push(raw)
}

func (g *Gateway) DisconnectCredential(id string) {
	g.mu.Lock()
	g.blocked[id] = true
	var drop []*connection
	for _, sl := range g.nodes {
		if sl.current != nil && sl.current.source.CredentialID == id {
			drop = append(drop, sl.current)
		}
	}
	g.mu.Unlock()
	for _, nc := range drop {
		nc.cancel()
		nc.ws.CloseNow()
	}
}

func (g *Gateway) Close() {
	g.mu.Lock()
	g.closed = true
	var drop []*connection
	for _, sl := range g.nodes {
		if sl.current != nil {
			drop = append(drop, sl.current)
		}
	}
	g.mu.Unlock()
	for _, nc := range drop {
		nc.cancel()
		nc.ws.CloseNow()
	}
}

func (g *Gateway) writeNode(nc *connection) {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-nc.ctx.Done():
			return
		case raw := <-nc.local:
			if writeRaw(nc.ctx, nc.ws, raw) != nil {
				return
			}
		case <-ticker.C:
			for i := 0; i < 8; i++ {
				raw, release, ok := nc.out.take()
				if !ok {
					break
				}
				err := writeRaw(nc.ctx, nc.ws, raw)
				release()
				if err != nil {
					return
				}
			}
			if raw, release, ok := nc.outOutput.take(); ok {
				err := writeRaw(nc.ctx, nc.ws, raw)
				release()
				if err != nil {
					return
				}
			}
		}
	}
}

func (g *Gateway) wakeUp() {
	select {
	case g.wake <- struct{}{}:
	default:
	}
}
func (g *Gateway) localError(nc *connection, code, id string) {
	raw, _ := json.Marshal(protocol.Frame{Kind: protocol.KindError, Code: code, Message: protocol.MessageOf(code), CorrelationID: id})
	select {
	case nc.local <- raw:
	default:
	}
}
func (g *Gateway) reject(ws *websocket.Conn, code string) {
	_ = writeFrame(context.Background(), ws, protocol.Frame{Kind: protocol.KindAuthResult, Code: code, Message: protocol.MessageOf(code)})
}
func writeFrame(ctx context.Context, ws *websocket.Conn, f protocol.Frame) error {
	raw, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return writeRaw(ctx, ws, raw)
}
func writeRaw(ctx context.Context, ws *websocket.Conn, raw []byte) error {
	timer := time.AfterFunc(5*time.Second, func() { ws.CloseNow() })
	defer timer.Stop()
	return ws.Write(ctx, websocket.MessageText, raw)
}
