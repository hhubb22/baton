package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/node"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTaskAPIAcceptQueryAndReplay(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	logs := &bytes.Buffer{}
	handler := newAPI(t, pool, logs)
	api := handler.(*httpapi.Server)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	aliceClient := tlsClient(t, srv)
	bobClient := tlsClient(t, srv)
	const password = "task-flow-password-001"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	bob := createEmployee(t, pool, "bob", "Bob", password)
	aliceCSRF := loginFor(t, aliceClient, srv.URL, "alice", password)
	bobCSRF := loginFor(t, bobClient, srv.URL, "bob", password)

	status, body, _ := postJSON(t, tlsClient(t, srv), srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "no-login", "description": "调查",
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("未登录状态 %d", status)
	}
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "no-csrf", "description": "调查",
	})
	if status != http.StatusForbidden || strings.Contains(body, "queued") {
		t.Fatalf("缺少 CSRF 的状态 %d", status)
	}

	early := registerNode(t, aliceClient, srv.URL, aliceCSRF, "Early", "pc", []string{"pi", "codex", "start"})
	later := registerNode(t, aliceClient, srv.URL, aliceCSRF, "Later", "pc", []string{"pi", "codex", "start"})
	bobNode := registerNode(t, bobClient, srv.URL, bobCSRF, "Bob Hidden Node", "pc", []string{"pi", "start"})
	setNodeAgent(t, ctx, pool, early.NodeID, "pi")
	setNodeAgent(t, ctx, pool, later.NodeID, "pi")
	setNodeAgent(t, ctx, pool, bobNode.NodeID, "pi")

	api.SetTaskCommitHookForTest(func(context.Context) error {
		return errors.New("commit-hook-secret")
	})
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "hook-1", "description": "do-not-log-task-text",
	}, aliceCSRF)
	if status != http.StatusInternalServerError || !strings.Contains(body, `"code":"unavailable"`) ||
		strings.Contains(body, "task_id") || strings.Contains(body, "queued") || strings.Contains(body, "commit-hook-secret") {
		t.Fatalf("未提交的响应是 %d %s", status, body)
	}
	if countTasks(t, ctx, pool, alice.ID) != 0 {
		t.Fatal("未提交的请求留下了任务")
	}
	api.SetTaskCommitHookForTest(nil)
	assertNoSecrets(t, "失败日志", logs.String(), "do-not-log-task-text", "commit-hook-secret")

	scope := "do-not-log-scope"
	payload := map[string]any{
		"request_id":          "job-1",
		"description":         "do-not-log-task-text",
		"authorization_scope": scope,
	}
	dropJSON(t, aliceClient, srv.URL+"/api/v1/tasks", aliceCSRF, payload)
	stored := storedTask(t, ctx, pool, alice.ID, "job-1")
	if stored.TaskID == "" || stored.TargetNodeID != early.NodeID || stored.AgentType != "pi" || stored.Status != task.StatusQueued {
		t.Fatalf("丢失响应后数据库里的任务不正确: %+v", stored)
	}
	if countTasks(t, ctx, pool, alice.ID) != 1 || countOutbox(t, ctx, pool, alice.ID) != 1 {
		t.Fatal("第一次接受没有恰好一条投递意图")
	}

	status, body = putJSON(t, aliceClient, srv.URL+"/api/v1/me/default-pc", origin, aliceCSRF, map[string]string{"node_id": later.NodeID})
	if status != http.StatusOK || !strings.Contains(body, later.NodeID) {
		t.Fatalf("修改默认设备状态 %d", status)
	}
	setNodeAgent(t, ctx, pool, early.NodeID, "codex")
	setNodeAgent(t, ctx, pool, later.NodeID, "codex")

	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", payload, aliceCSRF)
	if status != http.StatusOK {
		t.Fatalf("重试状态 %d %s", status, body)
	}
	var replay task.Record
	if err := json.Unmarshal([]byte(body), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.TaskID != stored.TaskID || replay.TargetNodeID != early.NodeID || replay.AgentType != "pi" ||
		replay.RequestID != "job-1" || replay.Version != 1 || replay.ExecutionTimeoutSeconds != task.DefaultExecutionTimeoutSeconds {
		t.Fatalf("重试没有返回原任务: %+v", replay)
	}
	delta := replay.QueueExpiresAt.Sub(replay.AcceptedAt)
	if delta < 599*time.Second || delta > 601*time.Second {
		t.Fatalf("排队期限是 %s", delta)
	}
	if countTasks(t, ctx, pool, alice.ID) != 1 {
		t.Fatal("响应丢失后的重试创建了新任务")
	}

	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "job-2", "description": "新的默认",
	}, aliceCSRF)
	if status != http.StatusOK {
		t.Fatalf("新请求状态 %d %s", status, body)
	}
	var created task.Record
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	if created.TaskID == replay.TaskID || created.TargetNodeID != later.NodeID || created.AgentType != "codex" {
		t.Fatalf("新请求没有使用新的默认值: %+v", created)
	}

	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "job-1", "description": "不同内容",
	}, aliceCSRF)
	if status != http.StatusConflict || !strings.Contains(body, `"code":"conflict"`) || !strings.Contains(body, replay.TaskID) {
		t.Fatalf("冲突响应是 %d %s", status, body)
	}
	if countTasks(t, ctx, pool, alice.ID) != 2 {
		t.Fatal("冲突请求创建了任务")
	}

	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "cross", "description": "越权", "target_node_id": bobNode.NodeID, "agent_type": "pi",
	}, aliceCSRF)
	if status != http.StatusForbidden || !strings.Contains(body, `"code":"forbidden"`) || strings.Contains(body, "Bob Hidden Node") {
		t.Fatalf("跨员工节点响应是 %d %s", status, body)
	}
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "unsupported", "description": "不支持", "agent_type": "kiro",
	}, aliceCSRF)
	if status != http.StatusBadRequest || !strings.Contains(body, `"code":"unsupported"`) {
		t.Fatalf("能力不匹配响应是 %d %s", status, body)
	}
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "bad-field", "description": "",
	}, aliceCSRF)
	if status != http.StatusBadRequest || !strings.Contains(body, `"code":"invalid_request"`) || !strings.Contains(body, `"description"`) {
		t.Fatalf("字段错误响应是 %d %s", status, body)
	}
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "fraction", "description": "调查", "queue_timeout_seconds": 1.5,
	}, aliceCSRF)
	if status != http.StatusBadRequest || !strings.Contains(body, `"code":"invalid_request"`) {
		t.Fatalf("小数期限响应是 %d %s", status, body)
	}
	big := strings.Repeat("测", 32768)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "too-big", "description": big, "authorization_scope": big, "expected_outputs": big,
	}, aliceCSRF)
	if status != http.StatusBadRequest || !strings.Contains(body, `"code":"invalid_request"`) || !strings.Contains(body, `"description"`) || !strings.Contains(body, `"authorization_scope"`) || !strings.Contains(body, `"expected_outputs"`) {
		t.Fatalf("超限任务输入响应是 %d %s", status, body)
	}
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/tasks", origin, "", map[string]any{
		"request_id": "with-employee", "description": "调查", "employee_id": bob.ID,
	}, aliceCSRF)
	if status != http.StatusBadRequest {
		t.Fatalf("正文指定员工的状态 %d", status)
	}
	if countTasks(t, ctx, pool, alice.ID) != 2 || countOutbox(t, ctx, pool, alice.ID) != 2 {
		t.Fatal("被拒绝的请求留下了任务或投递")
	}

	own := getRaw(t, aliceClient, srv.URL+"/api/v1/tasks/"+replay.TaskID)
	if own.StatusCode != http.StatusOK || !strings.Contains(own.Body, "do-not-log-task-text") || !strings.Contains(own.Body, early.NodeID) {
		t.Fatalf("本人查询是 %d %s", own.StatusCode, own.Body)
	}
	events := getRaw(t, aliceClient, srv.URL+"/api/v1/tasks/"+replay.TaskID+"/events")
	if events.StatusCode != http.StatusOK || !strings.Contains(events.Body, `"kind":"accepted"`) || strings.Contains(events.Body, "do-not-log-task-text") {
		t.Fatalf("事件响应是 %d %s", events.StatusCode, events.Body)
	}
	list := getRaw(t, aliceClient, srv.URL+"/api/v1/tasks")
	if list.StatusCode != http.StatusOK || !strings.Contains(list.Body, replay.TaskID) || !strings.Contains(list.Body, created.TaskID) {
		t.Fatalf("任务列表是 %d %s", list.StatusCode, list.Body)
	}
	foreign := getRaw(t, bobClient, srv.URL+"/api/v1/tasks/"+replay.TaskID)
	missing := getRaw(t, bobClient, srv.URL+"/api/v1/tasks/cccccccc-cccc-4ccc-8ccc-cccccccccccc")
	if foreign.StatusCode != http.StatusForbidden || missing.StatusCode != http.StatusForbidden ||
		!strings.Contains(foreign.Body, `"code":"forbidden"`) || !strings.Contains(missing.Body, `"code":"forbidden"`) ||
		strings.Contains(foreign.Body, "do-not-log-task-text") || strings.Contains(missing.Body, "do-not-log-task-text") {
		t.Fatalf("越权查询是 %s / %s", foreign.Body, missing.Body)
	}
	foreignEvents := getRaw(t, bobClient, srv.URL+"/api/v1/tasks/"+replay.TaskID+"/events")
	if foreignEvents.StatusCode != http.StatusForbidden || strings.Contains(foreignEvents.Body, "accepted") {
		t.Fatalf("越权事件是 %d %s", foreignEvents.StatusCode, foreignEvents.Body)
	}
	bobList := getRaw(t, bobClient, srv.URL+"/api/v1/tasks")
	if bobList.StatusCode != http.StatusOK || bobList.Body != "{\"tasks\":[]}\n" && !strings.Contains(bobList.Body, `"tasks":[]`) {
		t.Fatalf("他人的列表是 %s", bobList.Body)
	}
	if strings.Contains(bobList.Body, replay.TaskID) {
		t.Fatal("任务列表包含了其他员工的任务")
	}
	badID := getRaw(t, aliceClient, srv.URL+"/api/v1/tasks/not-a-uuid")
	if badID.StatusCode != http.StatusBadRequest || !strings.Contains(badID.Body, `"code":"invalid_id"`) {
		t.Fatalf("非法任务标识是 %d %s", badID.StatusCode, badID.Body)
	}
	filtered := getRaw(t, aliceClient, srv.URL+"/api/v1/tasks?employee_id="+bob.ID)
	if filtered.StatusCode != http.StatusBadRequest {
		t.Fatalf("查询参数状态 %d", filtered.StatusCode)
	}
	assertNoSecrets(t, "服务日志", logs.String(), password, aliceCSRF, bobCSRF, "do-not-log-task-text", "do-not-log-scope", "commit-hook-secret")
}

func TestTaskAPIConcurrent(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	api := newAPI(t, pool, io.Discard)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	const password = "task-race-password-001"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	pc := registerNode(t, client, srv.URL, csrf, "Desk", "pc", []string{"pi", "start"})
	setNodeAgent(t, ctx, pool, pc.NodeID, "pi")

	const n = 8
	payload := map[string]any{"request_id": "same", "description": "同一件事"}
	start := make(chan struct{})
	var wg sync.WaitGroup
	type result struct {
		status int
		body   string
		err    error
	}
	results := make(chan result, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			status, body, err := postStatus(client, srv.URL+"/api/v1/tasks", csrf, payload)
			results <- result{status, body, err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var taskID string
	for res := range results {
		if res.err != nil || res.status != http.StatusOK {
			t.Fatalf("并发接受状态 %d %v %s", res.status, res.err, res.body)
		}
		var rec task.Record
		if err := json.Unmarshal([]byte(res.body), &rec); err != nil {
			t.Fatal(err)
		}
		if taskID == "" {
			taskID = rec.TaskID
		}
		if rec.TaskID != taskID || rec.TargetNodeID != pc.NodeID {
			t.Fatalf("并发响应不一致: %+v", rec)
		}
	}
	if countTasks(t, ctx, pool, alice.ID) != 1 || countOutbox(t, ctx, pool, alice.ID) != 1 {
		t.Fatal("并发相同请求产生了多份投递")
	}

	start = make(chan struct{})
	conflicts := make(chan result, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		body := map[string]any{"request_id": "race", "description": fmt.Sprintf("版本-%d", i)}
		go func() {
			defer wg.Done()
			<-start
			status, text, err := postStatus(client, srv.URL+"/api/v1/tasks", csrf, body)
			conflicts <- result{status, text, err}
		}()
	}
	close(start)
	wg.Wait()
	close(conflicts)
	ok, conflict := 0, 0
	var winner string
	for res := range conflicts {
		if res.err != nil {
			t.Fatal(res.err)
		}
		switch res.status {
		case http.StatusOK:
			ok++
			var rec task.Record
			if err := json.Unmarshal([]byte(res.body), &rec); err != nil {
				t.Fatal(err)
			}
			winner = rec.TaskID
		case http.StatusConflict:
			conflict++
			if !strings.Contains(res.body, `"code":"conflict"`) {
				t.Fatalf("冲突正文是 %s", res.body)
			}
		default:
			t.Fatalf("并发冲突状态 %d %s", res.status, res.body)
		}
	}
	if ok != 1 || conflict != n-1 || winner == "" {
		t.Fatalf("并发冲突成功 %d 次，拒绝 %d 次", ok, conflict)
	}
	if countTasks(t, ctx, pool, alice.ID) != 2 || countOutbox(t, ctx, pool, alice.ID) != 2 {
		t.Fatal("并发冲突留下了错误数量的投递")
	}
}

func registerNode(t *testing.T, client *browser, base, csrf, name, role string, caps []string) node.Identity {
	t.Helper()
	enrollment := issueEnrollment(t, client, base, csrf)
	status, body, _ := postJSON(t, client, base+"/api/v1/nodes/register", "", "", registerBody(enrollment.EnrollmentToken, name, role, caps))
	if status != http.StatusOK {
		t.Fatalf("注册状态 %d %s", status, body)
	}
	var ident node.Identity
	if err := json.Unmarshal([]byte(body), &ident); err != nil {
		t.Fatal(err)
	}
	return ident
}

func setNodeAgent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, nodeID, agent string) {
	t.Helper()
	tag, err := pool.Exec(ctx, `UPDATE nodes SET default_agent_type = $2 WHERE id = $1::uuid`, nodeID, agent)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("设置默认 Agent 失败: %v", err)
	}
}

func storedTask(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID, requestID string) task.Record {
	t.Helper()
	var rec task.Record
	err := pool.QueryRow(ctx, `
		SELECT id::text, request_id, target_node_id::text, agent_type, status
		FROM tasks
		WHERE employee_id = $1::uuid AND request_id = $2`, employeeID, requestID).Scan(
		&rec.TaskID, &rec.RequestID, &rec.TargetNodeID, &rec.AgentType, &rec.Status)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func countTasks(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE employee_id = $1::uuid`, employeeID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func countOutbox(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM dispatch_outbox WHERE employee_id = $1::uuid`, employeeID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func dropJSON(t *testing.T, client *browser, rawURL, csrf string, payload any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	if csrf != "" {
		req.Header.Set(auth.CSRFHeader, csrf)
	}
	resp, err := client.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func postStatus(client *browser, rawURL, csrf string, payload any) (int, string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	if csrf != "" {
		req.Header.Set(auth.CSRFHeader, csrf)
	}
	resp, err := client.http.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(got), nil
}
