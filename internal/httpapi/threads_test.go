package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

type threadHTTPGateway struct{ calls atomic.Int64 }

func (g *threadHTTPGateway) SessionRequest(_ context.Context, _, _ string, req protocol.SessionRequest) (protocol.SessionResult, error) {
	g.calls.Add(1)
	result := protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID, OK: true, Text: "live output", Cursor: "output:1"}
	if req.Action == "history" {
		result.History = &protocol.SessionHistoryPage{Cursor: "history:1", Entries: []protocol.HistoryEntry{{Text: "native history", Reference: "pi:native:0"}}}
	}
	return result, nil
}

type threadHTTP struct {
	t       *testing.T
	pool    *pgxpool.Pool
	srv     *httptest.Server
	browser *browser
	csrf    string
	owner   string
	repo    *store.Store
	src     protocol.Source
	gateway *threadHTTPGateway
}

func newThreadHTTP(t *testing.T) *threadHTTP {
	t.Helper()
	pool := dbtest.Open(t)
	srv := httptest.NewUnstartedServer(nil)
	srv.StartTLS()
	t.Cleanup(srv.Close)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	gateway := &threadHTTPGateway{}
	api, err := httpapi.New(pool, httpapi.Settings{Origins: []string{origin, srv.URL}, SessionTTL: time.Hour, EnrollmentTTL: time.Minute, NodeCredentialTTL: time.Hour, Signer: signer, Sessions: gateway})
	if err != nil {
		t.Fatal(err)
	}
	api.SetEventIntervalForTest(10 * time.Millisecond)
	srv.Config.Handler = api
	b := tlsClient(t, srv)
	emp := createEmployee(t, pool, "thread-http", "Threads", "thread-http-password")
	if _, err = pool.Exec(t.Context(), `UPDATE employees SET must_change_password=false WHERE id=$1`, emp.ID); err != nil {
		t.Fatal(err)
	}
	csrf := loginFor(t, b, srv.URL, "thread-http", "thread-http-password")
	ident := registerIdent(t, b, srv.URL, csrf, "Desk")
	repo := store.New(pool)
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: emp.ID, NodeID: ident.NodeID, CredentialID: ident.Credential.ID, ConnID: threadHTTPID(t), Incarnation: threadHTTPID(t)}
	if err = repo.ConnectNode(t.Context(), src); err != nil {
		t.Fatal(err)
	}
	if err = repo.SyncNode(t.Context(), emp.ID, src.NodeID, src.ConnID, "Desk", ident.System, ident.Role, []string{"pi", "kiro"}); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.SaveRuntimeReport(t.Context(), src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: []protocol.RuntimeAgent{
		{AgentType: "pi", Version: "1.3.0", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Steer: true, Stop: true, Resume: true, SwitchModel: true}},
		{AgentType: "kiro", Version: "1", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Stop: true, Resume: true}},
	}}); err != nil {
		t.Fatal(err)
	}
	return &threadHTTP{t: t, pool: pool, srv: srv, browser: b, csrf: csrf, owner: emp.ID, repo: repo, src: src, gateway: gateway}
}
func threadHTTPID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func (h *threadHTTP) post(path string, payload any, want int) string {
	h.t.Helper()
	status, body, _ := postJSON(h.t, h.browser, h.srv.URL+"/api/v1"+path, origin, "", payload, h.csrf)
	if status != want {
		h.t.Fatalf("POST %s: %d want %d: %s", path, status, want, body)
	}
	return body
}
func (h *threadHTTP) create(key string) store.Thread {
	h.t.Helper()
	body := h.post("/threads", map[string]any{"client_thread_id": key, "agent_type": "pi", "working_directory": "/src/repo", "message": map[string]string{"client_message_id": key + ":first", "content": "hello"}}, 201)
	var v store.Thread
	if err := json.Unmarshal([]byte(body), &v); err != nil || v.ID == "" {
		h.t.Fatal(body, err)
	}
	return v
}
func (h *threadHTTP) report(id string, seq int64, kind string, turn int64, mid, reason string) {
	h.t.Helper()
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: threadHTTPID(h.t), WorkerSeq: seq, Kind: kind, WorkerTurnSeq: turn, ClientMessageID: mid, Reason: reason, QueueEmpty: true}
	if kind == "thread.opened" {
		r.StorageGeneration = "generation"
		r.NativeSessionID = "native"
	}
	if kind == "reply" {
		r.Content = "reply"
	}
	ack, err := h.repo.SaveThreadReport(h.t.Context(), h.src, r)
	if err != nil || !ack.OK {
		h.t.Fatal(kind, ack, err)
	}
}
func TestThreadHTTPFlowIsolationPaginationHistoryAndStop(t *testing.T) {
	h := newThreadHTTP(t)
	if err := h.repo.MarkOffline(t.Context(), h.src.NodeID, h.src.ConnID, time.Now()); err != nil {
		t.Fatal(err)
	}
	v := h.create("http")
	if v.Status != "waiting_device" {
		t.Fatal(v.Status)
	}
	message := map[string]string{"client_message_id": "http:first", "content": "hello"}
	in := map[string]any{"client_thread_id": "http", "agent_type": "pi", "working_directory": "/src/repo", "message": message}
	h.post("/threads", in, 200)
	message["content"] = "different"
	h.post("/threads", in, 409)
	status, text := getText(t, h.browser, h.srv.URL+"/api/v1/threads/"+v.ID)
	if status != 200 || !strings.Contains(text, `"node_online":false`) {
		t.Fatal(status, text)
	}
	_, history := getText(t, h.browser, h.srv.URL+"/api/v1/threads/"+v.ID+"/history")
	if !strings.Contains(history, "node_offline") || h.gateway.calls.Load() != 0 {
		t.Fatal(history)
	}
	if err := h.repo.ConnectNode(t.Context(), h.src); err != nil {
		t.Fatal(err)
	}
	if err := h.repo.SyncNode(t.Context(), h.owner, h.src.NodeID, h.src.ConnID, "Desk", "linux", "pc", []string{"pi", "kiro"}); err != nil {
		t.Fatal(err)
	}
	h.report(v.ID, 1, "thread.opened", 0, "", "")
	h.report(v.ID, 2, "turn.started", 1, "http:first", "")
	h.report(v.ID, 3, "message.sent", 1, "http:first", "")
	path := "/threads/" + v.ID
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "queue", Content: "next"}, 202)
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "queue", Content: "next"}, 202)
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "queue", Content: "changed"}, 409)
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "oversize", Content: strings.Repeat("\x01", 64<<10)}, 413)
	h.post(path+"/messages/http:first/withdraw", struct{}{}, 409)
	h.report(v.ID, 4, "message.queued", 0, "queue", "")
	h.post(path+"/messages/queue/withdraw", struct{}{}, 202)
	h.report(v.ID, 5, "message.withdrawn", 0, "queue", "")
	h.report(v.ID, 6, "reply", 1, "", "")
	h.post(path+"/stop", struct{}{}, 202)
	_, text = getText(t, h.browser, h.srv.URL+"/api/v1"+path)
	if !strings.Contains(text, `"status":"running"`) {
		t.Fatal("stopped before confirmation", text)
	}
	h.post(path+"/archive", struct{}{}, 202)
	h.report(v.ID, 7, "turn.ended", 1, "", "stopped")
	_, text = getText(t, h.browser, h.srv.URL+"/api/v1"+path)
	if !strings.Contains(text, `"status":"archived"`) {
		t.Fatal(text)
	}
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "late", Content: "no"}, 409)
	status, text = getText(t, h.browser, h.srv.URL+"/api/v1"+path+"/timeline?limit=2")
	var timeline store.ThreadTimeline
	if json.Unmarshal([]byte(text), &timeline) != nil || status != 200 || len(timeline.Events) != 2 || timeline.NextCursor == "" {
		t.Fatal(status, text)
	}
	status, text = getText(t, h.browser, h.srv.URL+"/api/v1"+path+"/timeline?cursor="+timeline.NextCursor)
	if status != 200 || !strings.Contains(text, `"kind":"reply"`) {
		t.Fatal(status, text)
	}
	for i := range 3 {
		h.create("page-" + string(rune('a'+i)))
	}
	status, text = getText(t, h.browser, h.srv.URL+"/api/v1/threads?limit=2&node_id="+h.src.NodeID)
	var page store.ThreadPage
	if status != 200 || json.Unmarshal([]byte(text), &page) != nil || len(page.Threads) != 2 || page.NextCursor == "" {
		t.Fatal(status, text)
	}
	status, text = getText(t, h.browser, h.srv.URL+"/api/v1/threads?limit=2&node_id="+h.src.NodeID+"&cursor="+url.QueryEscape(page.NextCursor))
	if status != 200 || json.Unmarshal([]byte(text), &page) != nil || len(page.Threads) != 2 {
		t.Fatal(status, text)
	}
	for _, suffix := range []string{"?bad=1", "?limit=0", "?node_id=bad", "?status=bad", "?cursor=bad", "?limit=1&limit=2"} {
		status, _ = getText(t, h.browser, h.srv.URL+"/api/v1/threads"+suffix)
		if status != 400 {
			t.Fatal(suffix, status)
		}
	}
	response, err := h.browser.http.Get(h.srv.URL + "/api/v1" + path + "/history?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result protocol.SessionResult
	if json.NewDecoder(response.Body).Decode(&result) != nil || !result.OK || result.History == nil || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal(result)
	}
	calls := h.gateway.calls.Load()
	other := createEmployee(t, h.pool, "thread-http-other", "Other", "thread-other-password")
	if _, err = h.pool.Exec(t.Context(), `UPDATE employees SET must_change_password=false WHERE id=$1`, other.ID); err != nil {
		t.Fatal(err)
	}
	foreignBrowser := tlsClient(t, h.srv)
	foreignCSRF := loginFor(t, foreignBrowser, h.srv.URL, "thread-http-other", "thread-other-password")
	for _, suffix := range []string{"", "/timeline", "/history"} {
		status, _ = getText(t, foreignBrowser, h.srv.URL+"/api/v1"+path+suffix)
		if status != 404 {
			t.Fatal("foreign GET", status, suffix)
		}
	}
	for _, action := range []string{"stop", "archive", "messages/queue/withdraw"} {
		status, _, _ = postJSON(t, foreignBrowser, h.srv.URL+"/api/v1"+path+"/"+action, origin, "", struct{}{}, foreignCSRF)
		if status != 404 {
			t.Fatal("foreign POST", action, status)
		}
	}
	status, _, _ = postJSON(t, foreignBrowser, h.srv.URL+"/api/v1"+path+"/messages", origin, "", store.ThreadMessageInput{ClientMessageID: "foreign", Content: "no"}, foreignCSRF)
	if status != 404 || h.gateway.calls.Load() != calls {
		t.Fatal("foreign access reached node", status)
	}
}

func TestThreadHTTPRejectsKiroSteer(t *testing.T) {
	h := newThreadHTTP(t)
	body := h.post("/threads", map[string]any{"client_thread_id": "kiro", "agent_type": "kiro", "working_directory": "/src/repo", "message": map[string]string{"client_message_id": "kiro:first", "content": "hello"}}, 201)
	var v store.Thread
	if err := json.Unmarshal([]byte(body), &v); err != nil || v.ID == "" {
		t.Fatal(body, err)
	}
	h.post("/threads/"+v.ID+"/messages", store.ThreadMessageInput{ClientMessageID: "steer", Content: "change", Mode: "steer"}, 422)
}

func TestThreadWebSocketSubscriptionOutputAndOwnership(t *testing.T) {
	h := newThreadHTTP(t)
	v := h.create("events")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(h.srv.URL, "https")+"/api/v1/events", &websocket.DialOptions{HTTPClient: h.browser.http, HTTPHeader: http.Header{"Origin": {h.srv.URL}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	raw, _ := json.Marshal(map[string]string{"thread_id": v.ID})
	if err = ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	changed, output := false, false
	for !changed || !output {
		_, raw, err = ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var event struct {
			Type     string `json:"type"`
			ThreadID string `json:"thread_id"`
			Text     string `json:"text"`
		}
		if err = json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		changed = changed || event.Type == "thread.changed"
		if event.Type == "thread.output" {
			if event.ThreadID != v.ID || event.Text != "live output" {
				t.Fatal(event)
			}
			output = true
		}
	}
	calls := h.gateway.calls.Load()
	raw, _ = json.Marshal(map[string]string{"thread_id": threadHTTPID(t)})
	if err = ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	for {
		if _, _, err = ws.Read(ctx); err != nil {
			break
		}
	}
	if ctx.Err() != nil || h.gateway.calls.Load() > calls+1 {
		t.Fatal("unauthorized subscription reached node")
	}
}
