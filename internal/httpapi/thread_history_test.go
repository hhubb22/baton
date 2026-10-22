package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
)

type historyGateway struct {
	calls atomic.Int64
	over  bool
	hook  func()
}

func (g *historyGateway) SessionRequest(_ context.Context, _, _ string, req protocol.SessionRequest) (protocol.SessionResult, error) {
	g.calls.Add(1)
	if g.hook != nil {
		g.hook()
	}
	text := "原生<script>文本</script>\x1b"
	if g.over {
		text = strings.Repeat("x", protocol.SessionHistoryBytes+1)
	}
	return protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID, OK: true, History: &protocol.SessionHistoryPage{Cursor: "next", Entries: []protocol.HistoryEntry{{Text: text, Reference: "node:entry"}}}}, nil
}

func TestThreadHistoryOwnershipLimitsAndRevocation(t *testing.T) {
	pool := dbtest.Open(t)
	srv := httptest.NewUnstartedServer(nil)
	srv.StartTLS()
	defer srv.Close()
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	gateway := &historyGateway{}
	api, err := httpapi.New(pool, httpapi.Settings{Origins: []string{origin, srv.URL}, SessionTTL: time.Hour, EnrollmentTTL: time.Minute, NodeCredentialTTL: time.Hour, Signer: signer, Sessions: gateway})
	if err != nil {
		t.Fatal(err)
	}
	srv.Config.Handler = api
	browser := tlsClient(t, srv)
	employee := createEmployee(t, pool, "historyalice", "Alice", "history-password")
	if _, err := pool.Exec(context.Background(), `UPDATE employees SET must_change_password=false WHERE id=$1`, employee.ID); err != nil {
		t.Fatal(err)
	}
	csrf := loginFor(t, browser, srv.URL, "historyalice", "history-password")
	ident := registerIdent(t, browser, srv.URL, csrf, "Desk")
	markOnline(t, pool, employee.ID, ident)
	id := createOwnedThread(t, pool, employee.ID, ident)
	get := func(suffix string) (int, protocol.SessionResult) {
		t.Helper()
		r, err := browser.http.Get(srv.URL + "/api/v1/threads/" + suffix)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var result protocol.SessionResult
		_ = json.NewDecoder(r.Body).Decode(&result)
		return r.StatusCode, result
	}
	foreign, _ := identity.NewUUID()
	for _, suffix := range []string{foreign + "/history", id + "/history?limit=17", id + "/history?limit=0", id + "/history?cursor=a&cursor=b", id + "/history?unknown=a", id + "/history?cursor=" + strings.Repeat("a", 101)} {
		code, _ := get(suffix)
		if code < 400 || gateway.calls.Load() != 0 {
			t.Fatal("越权或无效请求到达节点", code)
		}
	}
	code, result := get(id + "/history?limit=1")
	if code != 200 || !result.OK || strings.Contains(result.History.Entries[0].Text, "\x1b") {
		t.Fatal("历史页或控制字符处理错误")
	}
	gateway.over = true
	_, result = get(id + "/history")
	if result.OK || result.History != nil {
		t.Fatal("超限历史通过中心边界")
	}
	gateway.over = false
	// 节点响应等待期间登录退出，已经取回的正文也不能交付。
	gateway.hook = func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM login_sessions WHERE employee_id=$1`, employee.ID); err != nil {
			t.Fatal(err)
		}
	}
	code, result = get(id + "/history")
	if code != 401 || result.History != nil {
		t.Fatal("失效登录收到历史正文", code)
	}
}
