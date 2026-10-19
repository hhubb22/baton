package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/projectagent"
	"baton/internal/store"
)

func projectRequest(t *testing.T, client *browser, method, rawURL, csrf string, payload any) (int, string) {
	t.Helper()
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, rawURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.CSRFHeader, csrf)
	resp, err := client.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("响应缺少禁止缓存头")
	}
	return resp.StatusCode, string(got)
}

func TestProjectAPIIdentitySecurityAndMemory(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	srv := httptest.NewTLSServer(newAPI(t, pool, logs))
	t.Cleanup(srv.Close)
	alice, bob, anonymous := tlsClient(t, srv), tlsClient(t, srv), tlsClient(t, srv)
	const password = "project-api-test-password"
	owner := createEmployee(t, pool, "alice", "员工甲", password)
	createEmployee(t, pool, "bob", "员工乙", password)
	aCSRF := loginFor(t, alice, srv.URL, "alice", password)
	bCSRF := loginFor(t, bob, srv.URL, "bob", password)
	base := srv.URL + "/api/v1/projects"
	if status, _ := projectRequest(t, anonymous, "GET", base, "", nil); status != 401 {
		t.Fatalf("匿名访问: %d", status)
	}
	if status, _ := projectRequest(t, alice, "POST", base, "", map[string]any{"title": "越过 CSRF"}); status != 403 {
		t.Fatalf("CSRF: %d", status)
	}
	for _, field := range []string{"device_id", "node_id", "target_node_id", "working_directory", "directory", "repository", "employee_id"} {
		if status, _ := projectRequest(t, alice, "POST", base, aCSRF, map[string]any{"title": "禁止字段", field: "anything"}); status != 400 {
			t.Fatalf("创建接受 %s: %d", field, status)
		}
	}
	status, body := projectRequest(t, alice, "POST", base, aCSRF, map[string]any{"title": "Baton 项目"})
	if status != 201 {
		t.Fatalf("创建: %d %s", status, body)
	}
	var p projectagent.Project
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatal(err)
	}
	projectURL := base + "/" + p.ID
	for _, field := range []string{"device_id", "node_id", "target_node_id", "working_directory", "directory", "repository", "employee_id"} {
		if status, _ := projectRequest(t, alice, "PATCH", projectURL, aCSRF, map[string]any{field: "anything"}); status != 400 {
			t.Fatalf("修改接受 %s: %d", field, status)
		}
	}
	status, body = projectRequest(t, alice, "PATCH", projectURL, aCSRF, map[string]any{"title": "新项目名", "goal": "目标正文不进入日志", "status": "paused", "provider": "openai-codex", "model": "chosen-model"})
	if status != 200 {
		t.Fatalf("修改: %d %s", status, body)
	}
	var changed projectagent.Project
	if err := json.Unmarshal([]byte(body), &changed); err != nil {
		t.Fatal(err)
	}
	if changed.ID != p.ID || changed.Agent.ID != p.Agent.ID || changed.Conversation.ID != p.Conversation.ID || changed.Title != "新项目名" || changed.Version != 2 || changed.Agent.Model != "chosen-model" {
		t.Fatalf("修改结果: %+v", changed)
	}
	for _, path := range []string{"", "/events", "/memory"} {
		if status, _ := projectRequest(t, bob, "GET", projectURL+path, bCSRF, nil); status != 404 {
			t.Fatalf("跨员工读取 %s: %d", path, status)
		}
	}
	if status, _ := projectRequest(t, bob, "PATCH", projectURL, bCSRF, map[string]any{"title": "越权"}); status != 404 {
		t.Fatalf("跨员工修改: %d", status)
	}
	status, body = projectRequest(t, bob, "GET", base, bCSRF, nil)
	if status != 200 || !strings.Contains(body, `"projects":[]`) {
		t.Fatalf("项目列表泄漏: %s", body)
	}
	const entry = "10000000-0000-4000-8000-000000000001"
	memoryURL := projectURL + "/memory/" + entry
	for _, payload := range []map[string]any{
		{"title": "决定", "content": "正文"},
		{"title": "决定", "content": "正文", "expected_revision": 0, "author": "agent"},
		{"title": "决定", "content": "正文", "expected_revision": 0, "source_seq": 1},
	} {
		if status, _ := projectRequest(t, alice, "PUT", memoryURL, aCSRF, payload); status != 400 {
			t.Fatalf("记忆校验: %d", status)
		}
	}
	status, body = projectRequest(t, alice, "PUT", memoryURL, aCSRF, map[string]any{"title": "决定", "content": "用户原文", "expected_revision": 0})
	if status != 200 || !strings.Contains(body, `"revision":1`) || !strings.Contains(body, `"author":"user"`) {
		t.Fatalf("记忆创建: %d %s", status, body)
	}
	// Agent 工具走同一个存储入口，员工仍持有 revision=1。
	_, err := store.New(pool).WriteProjectMemory(t.Context(), owner.ID, p.ID, entry, projectagent.MemoryWrite{Title: "决定", Content: "Agent 已修改", Author: "agent", ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	status, body = projectRequest(t, alice, "PUT", memoryURL, aCSRF, map[string]any{"title": "决定", "content": "员工旧版本", "expected_revision": 1})
	if status != 409 || !strings.Contains(body, `"current_revision":2`) || !strings.Contains(body, "Agent 已修改") {
		t.Fatalf("并发冲突: %d %s", status, body)
	}
	if status, _ := projectRequest(t, bob, "GET", memoryURL, bCSRF, nil); status != 404 {
		t.Fatalf("跨员工记忆: %d", status)
	}
	if status, body := projectRequest(t, alice, "GET", memoryURL, aCSRF, nil); status != 200 || !strings.Contains(body, "Agent 已修改") {
		t.Fatalf("读取记忆: %d %s", status, body)
	}
	if status, body := projectRequest(t, alice, "GET", projectURL+"/memory", aCSRF, nil); status != 200 || !strings.Contains(body, entry) {
		t.Fatalf("记忆列表: %d %s", status, body)
	}
	assertNoSecrets(t, "Project 日志", logs.String(), "目标正文不进入日志", "用户原文", "Agent 已修改", "员工旧版本", password, aCSRF, bCSRF)
}

func TestProjectAPIMessagesBoundariesAndEvents(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	srv := httptest.NewTLSServer(newAPI(t, pool, logs))
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	const password = "messages-api-password"
	owner := createEmployee(t, pool, "alice", "员工", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	p, err := store.New(pool).CreateProject(t.Context(), owner.ID, projectagent.CreateInput{Title: "离线项目"})
	if err != nil {
		t.Fatal(err)
	}
	base := srv.URL + "/api/v1/projects/" + p.ID
	payload := map[string]any{"client_message_id": "one", "content": "恶意文本 <script>alert(1)</script>"}
	status, first := projectRequest(t, client, "POST", base+"/messages", csrf, payload)
	if status != 202 || strings.Contains(first, "<script>") {
		t.Fatalf("消息接受: %d %s", status, first)
	}
	status, replay := projectRequest(t, client, "POST", base+"/messages", csrf, payload)
	if status != 202 || replay != first {
		t.Fatalf("重发改变记录: %d %s", status, replay)
	}
	payload["content"] = "不同消息"
	if status, _ := projectRequest(t, client, "POST", base+"/messages", csrf, payload); status != 409 {
		t.Fatalf("不同内容重发: %d", status)
	}
	for i, tc := range []struct {
		content string
		status  int
	}{
		{strings.Repeat("x", 65536), 202},
		{strings.Repeat("x", 65537), 413},
		{strings.Repeat("中", 21845) + "x", 202},
		{strings.Repeat("中", 21846), 413},
		{strings.Repeat("<", 65536), 202},
		{"x" + strings.Repeat("\n", 65535), 413},
		{strings.Repeat("x", maxProjectWireBytesForTest), 413},
	} {
		status, body := projectRequest(t, client, "POST", base+"/messages", csrf, map[string]any{"client_message_id": fmt.Sprint(i), "content": tc.content})
		if status != tc.status {
			t.Fatalf("正文边界 %d: %d %s", i, status, body)
		}
	}
	status, body := projectRequest(t, client, "GET", base+"/events", csrf, nil)
	if status != 200 || !strings.Contains(body, `"events":[]`) || !strings.Contains(body, `"last_seq":0`) {
		t.Fatalf("未领取消息出现在事件中: %s", body)
	}
	for seq := 1; seq <= 3; seq++ {
		if _, err := pool.Exec(t.Context(), `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES($1,$2,$3,'assistant',$4)`, p.Conversation.ID, seq, owner.ID, `{"format":"pi-ai/1","message":{"content":[{"type":"thinking","thinkingSignature":"原始签名"}]}}`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(t.Context(), `UPDATE conversations SET next_seq=4 WHERE id=$1`, p.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	status, body = projectRequest(t, client, "GET", base+"/events?after_seq=1&limit=1", csrf, nil)
	var page projectagent.EventPage
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	if status != 200 || page.LastSeq != 3 || page.NextAfterSeq != 2 || !page.HasMore || len(page.Events) != 1 || page.Events[0].Seq != 2 || !strings.Contains(body, "原始签名") {
		t.Fatalf("分页: %d %s", status, body)
	}
	for _, query := range []string{"after_seq=-1", "after_seq=oops", "after_seq=1&after_seq=2", "limit=0", "limit=101", "node_id=bad", "after_seq=9223372036854775808", "after_seq=%zz"} {
		if status, _ := projectRequest(t, client, "GET", base+"/events?"+query, csrf, nil); status != 400 {
			t.Fatalf("非法分页 %s: %d", query, status)
		}
	}
	assertNoSecrets(t, "消息日志", logs.String(), "恶意文本", "不同消息", "原始签名")
}

const maxProjectWireBytesForTest = 512 << 10

// lostProjectResponse 丢弃已提交请求的 HTTP 响应，让客户端实际收到连接中断。
type lostProjectResponse struct{ header http.Header }

func (w *lostProjectResponse) Header() http.Header         { return w.header }
func (w *lostProjectResponse) WriteHeader(int)             {}
func (w *lostProjectResponse) Write(b []byte) (int, error) { return len(b), nil }

func TestProjectAPIResponseLossRetryAfterServerRestart(t *testing.T) {
	pool := dbtest.Open(t)
	api := newAPI(t, pool, io.Discard)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Lose-Response") == "yes" {
			api.ServeHTTP(&lostProjectResponse{header: make(http.Header)}, r)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		api.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	const password = "lost-response-password"
	owner := createEmployee(t, pool, "alice", "员工", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	p, err := store.New(pool).CreateProject(t.Context(), owner.ID, projectagent.CreateInput{Title: "断连项目"})
	if err != nil {
		t.Fatal(err)
	}
	msg := projectagent.MessageInput{ClientMessageID: "persisted-before-loss", Content: "断连重试正文"}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", srv.URL+"/api/v1/projects/"+p.ID+"/messages", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	req.Header.Set(auth.CSRFHeader, csrf)
	req.Header.Set("X-Test-Lose-Response", "yes")
	resp, err := client.http.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatal("客户端没有观察到响应丢失")
	}
	var originalID int64
	if err := pool.QueryRow(t.Context(), `SELECT id FROM project_agent_input_queue WHERE source_key='user:persisted-before-loss'`).Scan(&originalID); err != nil {
		t.Fatal(err)
	}
	srv.Close()
	restarted := httptest.NewTLSServer(newAPI(t, pool, io.Discard))
	t.Cleanup(restarted.Close)
	next := tlsClient(t, restarted)
	nextCSRF := loginFor(t, next, restarted.URL, "alice", password)
	status, body := projectRequest(t, next, "POST", restarted.URL+"/api/v1/projects/"+p.ID+"/messages", nextCSRF, msg)
	var saved projectagent.Message
	if err := json.Unmarshal([]byte(body), &saved); err != nil {
		t.Fatal(err)
	}
	if status != 202 || saved.ID != originalID {
		t.Fatalf("重启后未返回原记录: %d %s", status, body)
	}
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM project_agent_input_queue`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("重试产生重复输入: %d %v", count, err)
	}
}
