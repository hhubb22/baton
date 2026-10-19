package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/store"
)

func TestInboxAPIConcurrencyRetriesVersionsAndSecurity(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	repo := store.New(pool)
	srv := httptest.NewTLSServer(newAPI(t, pool, &bytes.Buffer{}))
	t.Cleanup(srv.Close)
	alice, bob, anonymous := tlsClient(t, srv), tlsClient(t, srv), tlsClient(t, srv)
	const password = "inbox-api-test-password"
	owner := createEmployee(t, pool, "alice", "员工甲", password)
	createEmployee(t, pool, "bob", "员工乙", password)
	aCSRF := loginFor(t, alice, srv.URL, "alice", password)
	bCSRF := loginFor(t, bob, srv.URL, "bob", password)
	p, err := repo.CreateProject(ctx, owner.ID, projectagent.CreateInput{Title: "事项 Project"})
	if err != nil {
		t.Fatal(err)
	}
	b := inbox.Binding{EmployeeID: owner.ID, ProjectID: p.ID, AgentID: p.Agent.ID, ConversationID: p.Conversation.ID}
	create := func(call string) inbox.Request {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		r, err := inbox.CreateAgent(ctx, tx, b, call, inbox.Ask{Title: "请决定", Content: "Markdown", Options: []inbox.Option{{ID: "go", Label: "继续"}}, AllowText: true}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := create("api-first")
	base := srv.URL + "/api/v1/attention-requests/" + r.ID
	for _, path := range []string{"/api/v1/inbox", "/api/v1/attention-requests/" + r.ID} {
		if code, _ := projectRequest(t, anonymous, "GET", srv.URL+path, "", nil); code != 401 {
			t.Fatal("匿名读取", code)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		path := base
		if method == "POST" {
			path += "/close"
		}
		if code, _ := projectRequest(t, bob, method, path, bCSRF, map[string]any{"expected_version": 1, "client_request_id": "foreign"}); code != 404 {
			t.Fatal("跨员工访问", code)
		}
	}
	if code, body := projectRequest(t, bob, "GET", srv.URL+"/api/v1/inbox", bCSRF, nil); code != 200 || !strings.Contains(body, `"requests":[]`) {
		t.Fatal(code, body)
	}
	answer := map[string]any{"expected_version": 1, "client_request_id": "answer", "option_id": "go", "text": "继续调查"}
	if code, _ := projectRequest(t, alice, "POST", base+"/answer", "", answer); code != 403 {
		t.Fatal("未校验 CSRF", code)
	}
	for _, bad := range []map[string]any{
		{"expected_version": 1, "option_id": "go"},
		{"expected_version": 1, "client_request_id": "bad-option", "option_id": "other"},
		{"expected_version": 1, "client_request_id": "empty"},
		{"expected_version": 1, "client_request_id": "too-large", "text": strings.Repeat("x", 4097)},
		{"expected_version": 1, "client_request_id": "unknown", "option_id": "go", "employee_id": owner.ID},
	} {
		if code, _ := projectRequest(t, alice, "POST", base+"/answer", aCSRF, bad); code != 400 {
			t.Fatal("参数未拒绝", code)
		}
	}
	stale := map[string]any{"expected_version": 2, "client_request_id": "stale", "option_id": "go"}
	if code, body := projectRequest(t, alice, "POST", base+"/answer", aCSRF, stale); code != 409 || !strings.Contains(body, `"current"`) || !strings.Contains(body, `"version":1`) {
		t.Fatal(code, body)
	}
	// 两个浏览器连接同时发送回答；每个请求使用不同请求标识。
	second := tlsClient(t, srv)
	secondCSRF := loginFor(t, second, srv.URL, "alice", password)
	start := make(chan struct{})
	codes := make(chan int, 2)
	go func() {
		<-start
		code, _ := projectRequest(t, alice, "POST", base+"/answer", aCSRF, answer)
		codes <- code
	}()
	go func() {
		<-start
		code, _ := projectRequest(t, second, "POST", base+"/answer", secondCSRF, map[string]any{"expected_version": 1, "client_request_id": "other-answer", "text": "稍后"})
		codes <- code
	}()
	close(start)
	one, two := <-codes, <-codes
	if !((one == 200 && two == 409) || (one == 409 && two == 200)) {
		t.Fatal(one, two)
	}
	current, err := repo.AttentionRequest(ctx, owner.ID, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	retry := map[string]any{"expected_version": 1, "client_request_id": current.Resolution.ClientRequestID, "option_id": "go"}
	if code, body := projectRequest(t, alice, "POST", base+"/answer", aCSRF, retry); code != 200 || !strings.Contains(body, `"state":"answered"`) {
		t.Fatal(code, body)
	}
	if code, _ := projectRequest(t, alice, "POST", base+"/close", aCSRF, map[string]any{"expected_version": 1, "client_request_id": "close-late"}); code != 409 {
		t.Fatal(code)
	}
	var n int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='attention_answer'`).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	closed := create("api-close")
	if code, _ := projectRequest(t, alice, "POST", srv.URL+"/api/v1/attention-requests/"+closed.ID+"/close", aCSRF, map[string]any{"expected_version": 1, "client_request_id": "close"}); code != 200 {
		t.Fatal(code)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='attention_answer'`).Scan(&n); err != nil || n != 2 {
		t.Fatal("关闭提案缺输入", n, err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = inbox.CreateSystem(ctx, tx, b, inbox.ProjectNeedsAttention, p.ID, "需要处理", "原因", "", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := repo.Inbox(ctx, owner.ID, "open", "")
	if err != nil || len(page.Requests) != 1 {
		t.Fatal(page, err)
	}
	sys := srv.URL + "/api/v1/attention-requests/" + page.Requests[0].ID
	if code, _ := projectRequest(t, alice, "POST", sys+"/answer", aCSRF, answer); code != 400 {
		t.Fatal("系统接受回答", code)
	}
	if code, _ := projectRequest(t, alice, "POST", sys+"/close", aCSRF, map[string]any{"expected_version": 1, "client_request_id": "close-system"}); code != 200 {
		t.Fatal(code)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='attention_answer'`).Scan(&n); err != nil || n != 2 {
		t.Fatal("系统关闭写入队列", n, err)
	}
	code, body := projectRequest(t, alice, "GET", srv.URL+"/api/v1/inbox?state=done", aCSRF, nil)
	if code != 200 {
		t.Fatal(code, body)
	}
	var done inbox.Page
	if err = json.Unmarshal([]byte(body), &done); err != nil || len(done.Requests) != 3 || done.OpenCount != 0 {
		t.Fatal(done, err)
	}
	t.Log("HTTP 双连接回答 200/409、请求重试 200、版本冲突含 current、身份和 CSRF、系统只能关闭且无输入")
}
