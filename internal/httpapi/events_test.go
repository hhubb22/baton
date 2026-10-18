package httpapi_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"github.com/coder/websocket"
)

type sessionGateway struct {
	calls atomic.Int64
	text  string
}

func (g *sessionGateway) SessionRequest(_ context.Context, _, _ string, req protocol.SessionRequest) (protocol.SessionResult, error) {
	g.calls.Add(1)
	text := g.text
	if text == "" {
		text = "<script>window.pwned=true</script>"
	}
	return protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID, OK: true, State: "running", InputSupported: true, Text: text, Cursor: "fixture:1"}, nil
}
func TestBrowserEventsAuthenticationOwnershipAndLogout(t *testing.T) {
	pool := dbtest.Open(t)
	srv := httptest.NewUnstartedServer(nil)
	srv.StartTLS()
	defer srv.Close()
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	gateway := &sessionGateway{}
	api, err := httpapi.New(pool, httpapi.Settings{Origins: []string{origin, srv.URL}, SessionTTL: time.Hour, EnrollmentTTL: time.Minute, NodeCredentialTTL: time.Hour, Signer: signer, Sessions: gateway})
	if err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = api
	browser := tlsClient(t, srv)
	employee := createEmployee(t, pool, "eventalice", "Alice", "events-password")
	if _, err := pool.Exec(context.Background(), `UPDATE employees SET must_change_password=false WHERE id=$1`, employee.ID); err != nil {
		t.Fatal(err)
	}
	csrf := loginFor(t, browser, srv.URL, "eventalice", "events-password")
	ident := registerIdent(t, browser, srv.URL, csrf, "Desk")
	markOnline(t, pool, employee.ID, ident)
	id, _ := identity.NewUUID()
	if _, err := pool.Exec(context.Background(), `INSERT INTO sessions(id,employee_id,node_id,agent_type,status,created_at,updated_at) VALUES($1,$2,$3,'pi','running',now(),now())`, id, employee.ID, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	u, _ := url.Parse(srv.URL)
	cookie := ""
	for _, c := range browser.jar.Cookies(u) {
		if c.Name == auth.SessionCookieName {
			cookie = c.String()
		}
	}
	dial := func(origin, cookie string) (*websocket.Conn, *http.Response, error) {
		return websocket.Dial(ctx, "wss"+strings.TrimPrefix(srv.URL, "https")+"/api/v1/events", &websocket.DialOptions{HTTPClient: browser.http, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {cookie}}})
	}
	// 浏览器 Cookie 和 Origin 分别缺失时，升级必须失败。
	for _, badOrigin := range []string{"", "https://evil.example", origin} {
		ws, res, err := dial(badOrigin, cookie)
		if err == nil {
			ws.CloseNow()
			t.Fatal("跨源升级成功")
		}
		if res == nil || res.StatusCode != 403 {
			t.Fatalf("跨源状态: %v", res)
		}
	}
	noJar := *browser.http
	noJar.Jar = nil
	if ws, res, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(srv.URL, "https")+"/api/v1/events", &websocket.DialOptions{HTTPClient: &noJar, HTTPHeader: http.Header{"Origin": {srv.URL}}}); err == nil {
		ws.CloseNow()
		t.Fatal("无登录 Cookie 的升级成功")
	} else if res == nil || res.StatusCode != 401 {
		t.Fatal("未登录状态错误")
	}
	ws, _, err := dial(srv.URL, cookie)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	raw, _ := json.Marshal(map[string]string{"session_id": id})
	if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	found := false
	for i := 0; i < 6; i++ {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var event struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &event) != nil {
			t.Fatal("事件格式错误")
		}
		if event.Type == "session.output" {
			if !strings.Contains(event.Text, "<script>") {
				t.Fatal("输出没有保持为数据")
			}
			found = true
			break
		}
	}
	if !found || gateway.calls.Load() == 0 {
		t.Fatal("没有收到本人输出")
	}
	calls := gateway.calls.Load()
	foreign, _ := identity.NewUUID()
	raw, _ = json.Marshal(map[string]string{"session_id": foreign})
	if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	for {
		if _, _, err := ws.Read(ctx); err != nil {
			break
		}
	}
	if gateway.calls.Load() != calls {
		t.Fatal("不可见 Session 发起了节点 RPC")
	}
	ws, _, err = dial(srv.URL, cookie)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if _, _, err := ws.Read(ctx); err != nil {
		t.Fatal(err)
	}
	status, _, _ := postJSON(t, browser, srv.URL+"/api/v1/logout", origin, "", nil, csrf)
	if status != 204 {
		t.Fatalf("退出状态 %d", status)
	}
	for {
		if _, _, err := ws.Read(ctx); err != nil {
			break
		}
	}
	if ctx.Err() != nil {
		t.Fatal("退出后长连接没有及时关闭")
	}
}

func TestBrowserSlowTransportReleasesConnectionSlot(t *testing.T) {
	pool := dbtest.Open(t)
	srv := httptest.NewUnstartedServer(nil)
	srv.StartTLS()
	defer srv.Close()
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	gateway := &sessionGateway{text: strings.Repeat("x", protocol.SessionOutputBytes)}
	api, err := httpapi.New(pool, httpapi.Settings{Origins: []string{origin, srv.URL}, SessionTTL: time.Hour, EnrollmentTTL: time.Minute, NodeCredentialTTL: time.Hour, Signer: signer, Sessions: gateway})
	if err != nil {
		t.Fatal(err)
	}
	api.SetEventIntervalForTest(time.Millisecond)
	srv.Config.Handler = api
	browser := tlsClient(t, srv)
	employee := createEmployee(t, pool, "slowalice", "Alice", "events-password")
	if _, err := pool.Exec(context.Background(), `UPDATE employees SET must_change_password=false WHERE id=$1`, employee.ID); err != nil {
		t.Fatal(err)
	}
	csrf := loginFor(t, browser, srv.URL, "slowalice", "events-password")
	ident := registerIdent(t, browser, srv.URL, csrf, "Desk")
	markOnline(t, pool, employee.ID, ident)
	id, _ := identity.NewUUID()
	if _, err := pool.Exec(context.Background(), `INSERT INTO sessions(id,employee_id,node_id,agent_type,status,created_at,updated_at) VALUES($1,$2,$3,'pi','running',now(),now())`, id, employee.ID, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	transport := browser.http.Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if tcp, ok := c.(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(1024)
		}
		return c, err
	}
	client := &http.Client{Transport: transport, Jar: browser.jar}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(srv.URL, "https")+"/api/v1/events", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {srv.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if _, _, err := ws.Read(ctx); err != nil {
		t.Fatal(err)
	}
	if api.BrowserConnectionsForTest() != 1 {
		t.Fatal("连接没有占用预算")
	}
	raw, _ := json.Marshal(map[string]string{"session_id": id})
	if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	for time.Since(started) < 10*time.Second && api.BrowserConnectionsForTest() != 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if api.BrowserConnectionsForTest() != 0 {
		t.Fatal("慢传输没有在写入超时后回收连接名额")
	}
	if gateway.calls.Load() < 4 || time.Since(started) < 2*time.Second {
		t.Fatal("没有实际填满传输缓冲并经历写入超时")
	}
	t.Logf("慢传输在 %s 后关闭，节点输出读取 %d 次，连接名额已释放", time.Since(started).Round(time.Millisecond), gateway.calls.Load())
}
