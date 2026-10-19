package gateway_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/control"
	"baton/internal/dbtest"
	"baton/internal/gateway"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"

	"github.com/coder/websocket"
)

func TestGatewayAuthSyncAndIsolation(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	alice, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "relay-test-password-01")
	if err != nil {
		t.Fatal(err)
	}
	desk := registerNode(t, ctx, repo, signer, alice.ID, "Desk")
	other := registerNode(t, ctx, repo, signer, alice.ID, "Other")
	revoked := registerNode(t, ctx, repo, signer, alice.ID, "Revoked")
	if _, err := pool.Exec(ctx, `UPDATE node_credentials SET revoked_at = now() WHERE id = $1::uuid`, revoked.Credential.ID); err != nil {
		t.Fatal(err)
	}
	ctrl, err := control.New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := gateway.New(ctrl, ctrl, 30*time.Second, nil)
	ctrl.SetSender(server)
	srv := httptest.NewTLSServer(server)
	t.Cleanup(srv.Close)
	nodeRoots := x509.NewCertPool()
	nodeRoots.AddCert(srv.Certificate())
	runCtx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	t.Cleanup(server.Close)
	go server.Run(runCtx)
	addr := strings.TrimPrefix(srv.URL, "https://")

	badSigner, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	badToken, err := badSigner.SignNodeToken(desk.NodeID, alice.ID, desk.Credential.ID, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if result := dialResult(t, addr, badToken, newID(t), nodeRoots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("伪造签名被接受: %+v", result)
	}
	if result := dialResult(t, addr, revoked.Credential.Token, newID(t), nodeRoots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("已吊销凭据被接受: %+v", result)
	}

	inc := newID(t)
	deskPeer, result := dialPeer(t, addr, desk.Credential.Token, inc, nodeRoots)
	if !result.OK {
		t.Fatalf("合法节点被拒绝: %+v", result)
	}
	t.Cleanup(func() { deskPeer.ws.Close(websocket.StatusNormalClosure, "") })
	view := waitStatus(t, repo, alice.ID, desk.NodeID, func(v store.NodeView) bool {
		return v.Online && !v.Synced && !v.Executable()
	})
	if view.LastContact == nil || view.StatusUpdated == nil {
		t.Fatal("在线节点缺少联系时间或状态时间")
	}

	otherPeer, result := dialPeer(t, addr, other.Credential.Token, newID(t), nodeRoots)
	if !result.OK {
		t.Fatalf("第二个节点被拒绝: %+v", result)
	}
	t.Cleanup(func() { otherPeer.ws.Close(websocket.StatusNormalClosure, "") })

	sendEnvelope(t, deskPeer.ws, map[string]any{
		"version": protocol.Version, "message_id": newID(t),
		"route":  map[string]string{"to": protocol.ToControl},
		"source": map[string]string{"kind": "node", "node_id": other.NodeID},
		"body":   map[string]string{"type": "node.sync"},
	})
	if got := deskPeer.next(t); got.Code != protocol.CodeForgedSource {
		t.Fatalf("伪造来源得到 %s", got.Code)
	}
	otherPeer.expectSilent(t)

	sendEnvelope(t, deskPeer.ws, map[string]any{
		"version": protocol.Version, "message_id": newID(t),
		"route": map[string]string{"to": other.NodeID},
		"body":  map[string]string{"type": "ping"},
	})
	if got := deskPeer.next(t); got.Code != protocol.CodeRouteForbidden {
		t.Fatalf("节点直投得到 %s", got.Code)
	}
	otherPeer.expectSilent(t)

	syncID := newID(t)
	sendEnvelope(t, deskPeer.ws, map[string]any{
		"version": protocol.Version, "message_id": syncID,
		"route":    map[string]string{"to": protocol.ToControl},
		"priority": protocol.PriorityControl,
		"body": map[string]any{
			"type": "node.sync", "display_name": "Desk", "system": "linux", "role": "pc", "capabilities": []string{"start"},
		},
	})
	synced := deskPeer.next(t)
	var wrap struct {
		Envelope protocol.Envelope `json:"envelope"`
	}
	raw, _ := json.Marshal(synced)
	if err := json.Unmarshal(raw, &wrap); err != nil || wrap.Envelope.CorrelationID != syncID {
		t.Fatalf("同步响应不正确: %s", raw)
	}
	waitStatus(t, repo, alice.ID, desk.NodeID, func(v store.NodeView) bool { return v.Executable() })

	if result := dialResult(t, addr, desk.Credential.Token, newID(t), nodeRoots); result.Code != protocol.CodeIncarnationConflict {
		t.Fatalf("不同 incarnation 被接受: %+v", result)
	}
	var oldConnID string
	if err := pool.QueryRow(ctx, `SELECT conn_id FROM node_presence WHERE node_id=$1::uuid`, desk.NodeID).Scan(&oldConnID); err != nil {
		t.Fatal(err)
	}
	replaced := make(chan struct{}, 1)
	go func() {
		if _, ok := <-deskPeer.frames; !ok {
			replaced <- struct{}{}
		}
	}()
	newPeer, result := dialPeer(t, addr, desk.Credential.Token, inc, nodeRoots)
	if !result.OK {
		t.Fatalf("同一进程重连被拒绝: %+v", result)
	}
	t.Cleanup(func() { newPeer.ws.Close(websocket.StatusNormalClosure, "") })
	select {
	case <-replaced:
	case <-time.After(3 * time.Second):
		t.Fatal("同一 incarnation 没有替换旧连接")
	}
	waitStatus(t, repo, alice.ID, desk.NodeID, func(v store.NodeView) bool { return v.Online && !v.Synced })
	oldSource := protocol.Source{Kind: protocol.SourceNode, NodeID: desk.NodeID, EmployeeID: alice.ID, CredentialID: desk.Credential.ID, ConnID: oldConnID, Incarnation: inc}
	if err := ctrl.Handle(ctx, oldSource, protocol.Envelope{Body: json.RawMessage(`{"type":"node.sync"}`)}); err == nil {
		t.Fatal("旧连接的迟到消息通过了业务分派")
	}
	sendEnvelope(t, newPeer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]string{"type": "arbitrary.route"}})
	if got := newPeer.next(t); got.Code != protocol.CodeInvalidMessage {
		t.Fatalf("未知业务类型未拒绝: %+v", got)
	}
	oversizedRaw := []byte(`{"kind":"heartbeat","extra":"` + strings.Repeat("x", protocol.MaxMessageBytes) + `"}`)
	timed, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	_ = newPeer.ws.Write(timed, websocket.MessageText, oversizedRaw)
	newPeer.waitClosed(t)

}

type peer struct {
	ws     *websocket.Conn
	frames chan protocol.Frame
}

func dialPeer(t *testing.T, addr, token, incarnation string, roots *x509.CertPool) (*peer, protocol.Frame) {
	t.Helper()
	ws := dialSocket(t, addr, roots)
	result := authSocket(t, ws, token, incarnation)
	p := &peer{ws: ws, frames: make(chan protocol.Frame, 8)}
	if result.OK {
		go p.loop()
	} else {
		ws.Close(websocket.StatusNormalClosure, "")
	}
	return p, result
}

func dialResult(t *testing.T, addr, token, incarnation string, roots *x509.CertPool) protocol.Frame {
	t.Helper()
	_, result := dialPeer(t, addr, token, incarnation, roots)
	return result
}

func (p *peer) loop() {
	for {
		_, raw, err := p.ws.Read(context.Background())
		if err != nil {
			close(p.frames)
			return
		}
		var frame protocol.Frame
		if json.Unmarshal(raw, &frame) == nil {
			p.frames <- frame
		}
	}
}

func (p *peer) next(t *testing.T) protocol.Frame {
	t.Helper()
	select {
	case frame, ok := <-p.frames:
		if !ok {
			t.Fatal("连接在收到响应前关闭")
		}
		return frame
	case <-time.After(5 * time.Second):
		t.Fatal("等待响应超时")
		return protocol.Frame{}
	}
}

func (p *peer) expectSilent(t *testing.T) {
	t.Helper()
	select {
	case frame, ok := <-p.frames:
		if ok {
			t.Fatalf("节点收到了不应投递的消息: %+v", frame)
		}
	case <-time.After(400 * time.Millisecond):
	}
}

func dialSocket(t *testing.T, addr string, roots *x509.CertPool) *websocket.Conn {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
	}}}
	ws, _, err := websocket.Dial(context.Background(), "wss://"+addr+protocol.NodePath, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(protocol.MaxMessageBytes)
	return ws
}

func authSocket(t *testing.T, ws *websocket.Conn, token, incarnation string) protocol.Frame {
	t.Helper()
	raw, err := json.Marshal(protocol.Frame{Kind: protocol.KindAuth, Token: token, Incarnation: incarnation})
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	_, resp, err := ws.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var frame protocol.Frame
	if err := json.Unmarshal(resp, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func sendEnvelope(t *testing.T, ws *websocket.Conn, env any) {
	t.Helper()
	body, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: body})
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
}

func waitStatus(t *testing.T, repo *store.Store, employeeID, nodeID string, match func(store.NodeView) bool) store.NodeView {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last store.NodeView
	for time.Now().Before(deadline) {
		view, err := repo.OwnNode(context.Background(), employeeID, nodeID)
		if err == nil {
			last = view
			if match(view) {
				return view
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("节点状态没有达到预期: %+v", last)
	return last
}

func registerNode(t *testing.T, ctx context.Context, repo *store.Store, signer node.Signer, employeeID, name string) node.Identity {
	t.Helper()
	_, token, _, err := repo.IssueEnrollment(ctx, employeeID, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ident, err := repo.Register(ctx, store.RegisterInput{
		Token: token, DisplayName: name, System: node.SystemLinux, Role: node.RolePC,
		Capabilities: []string{"start"}, CredentialTTL: 30 * 24 * time.Hour,
	}, signer)
	if err != nil {
		t.Fatal(err)
	}
	return ident
}

func newID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
