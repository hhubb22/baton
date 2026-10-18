package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/task"
)

func TestManualTaskAPIAuthenticationValidationAndAudit(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs).(*httpapi.Server)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client, other := tlsClient(t, srv), tlsClient(t, srv)
	const password = "resolve-flow-password-001"
	employee := createEmployee(t, pool, "alice", "Alice", password)
	createEmployee(t, pool, "bob", "Bob", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	otherCSRF := loginFor(t, other, srv.URL, "bob", password)
	node := registerNode(t, client, srv.URL, csrf, "Desk", "pc", []string{"pi", "start"})
	setNodeAgent(t, ctx, pool, node.NodeID, "pi")
	code, body, _ := postJSON(t, client, srv.URL+"/api/v1/tasks", origin, "", map[string]any{"request_id": "original", "description": "private-task-description"}, csrf)
	if code != 200 {
		t.Fatalf("创建: %d %s", code, body)
	}
	var original task.Record
	if err := json.Unmarshal([]byte(body), &original); err != nil {
		t.Fatal(err)
	}
	base := srv.URL + "/api/v1/tasks/" + original.TaskID
	request := map[string]any{"expected_version": original.Version, "status": task.StatusCompleted, "summary": "private-review-summary", "reason": "private-review-reason", "evidence": []map[string]string{{"storage_ref": "inspection", "resource_id": "private-review-evidence", "access_status": "available"}}}
	for _, action := range []string{"resolve", "rerun"} {
		url := base + "/" + action
		if status, _, _ := postJSON(t, tlsClient(t, srv), url, origin, "", request); status != 401 {
			t.Fatalf("%s 未登录: %d", action, status)
		}
		if status, _, _ := postJSON(t, client, url, origin, "", request); status != 403 {
			t.Fatalf("%s 缺少 CSRF: %d", action, status)
		}
		if status, _, _ := postJSON(t, client, url, "https://evil.invalid", "", request, csrf); status != 403 {
			t.Fatalf("%s 外域: %d", action, status)
		}
	}
	if status, _, _ := postJSON(t, client, base+"/resolve", origin, "", request, csrf); status != 409 {
		t.Fatalf("排队任务被核实: %d", status)
	}
	if status, _, _ := postJSON(t, client, base+"/cancel", origin, "", map[string]any{}, csrf); status != 200 {
		t.Fatalf("取消: %d", status)
	}
	original = storedTask(t, ctx, pool, employee.ID, "original")
	if err := pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id = $1::uuid`, original.TaskID).Scan(&original.Version); err != nil {
		t.Fatal(err)
	}
	request["expected_version"] = original.Version
	for _, action := range []string{"resolve", "rerun"} {
		payload := any(request)
		if action == "rerun" {
			payload = map[string]any{"request_id": "unauthorized", "expected_version": original.Version, "reason": "redo"}
		}
		if status, body, _ := postJSON(t, other, base+"/"+action, origin, "", payload, otherCSRF); status != 403 || strings.Contains(body, "current_version") {
			t.Fatalf("%s 越权: %d %s", action, status, body)
		}
		if status, _, _ := postJSON(t, client, base+"/"+action+"?unused=true", origin, "", payload, csrf); status != 400 {
			t.Fatalf("%s 查询参数: %d", action, status)
		}
		if status, _, _ := postJSON(t, client, srv.URL+"/api/v1/tasks/not-a-uuid/"+action, origin, "", payload, csrf); status != 400 {
			t.Fatalf("%s 无效 ID: %d", action, status)
		}
	}
	for _, field := range []string{"expected_version", "reason", "summary", "evidence"} {
		invalid := make(map[string]any)
		for k, v := range request {
			invalid[k] = v
		}
		delete(invalid, field)
		if status, body, _ := postJSON(t, client, base+"/resolve", origin, "", invalid, csrf); status != 400 {
			t.Fatalf("缺少 %s: %d %s", field, status, body)
		}
	}
	invalid := map[string]any{"expected_version": original.Version, "status": "running", "reason": "不合法", "summary": "不能继续运行", "evidence_empty_reason": "无"}
	if status, _, _ := postJSON(t, client, base+"/resolve", origin, "", invalid, csrf); status != 400 {
		t.Fatalf("非法结论: %d", status)
	}
	api.SetTaskCommitHookForTest(func(context.Context) error { return errors.New("private-commit-error") })
	if status, body, _ := postJSON(t, client, base+"/resolve", origin, "", request, csrf); status != 500 || strings.Contains(body, "private-") {
		t.Fatalf("失败响应: %d %s", status, body)
	}
	api.SetTaskCommitHookForTest(nil)
	code, body, _ = postJSON(t, client, base+"/resolve", origin, "", request, csrf)
	var resolved task.Record
	if err := json.Unmarshal([]byte(body), &resolved); err != nil {
		t.Fatal(err)
	}
	if code != 200 || resolved.Status != task.StatusCompleted || resolved.TaskID != original.TaskID || resolved.Version != original.Version+1 {
		t.Fatalf("核实: %d %s", code, body)
	}
	if status, body, _ := postJSON(t, client, base+"/resolve", origin, "", request, csrf); status != 409 || !strings.Contains(body, `"current_version":`+fmt.Sprint(resolved.Version)) || !strings.Contains(body, `"current_status":"completed"`) {
		t.Fatalf("版本冲突: %d %s", status, body)
	}
	rerun := task.RerunInput{RequestID: "new-execution", ExpectedVersion: resolved.Version, Reason: "private-rerun-reason"}
	var next task.Record
	for i := 0; i < 2; i++ {
		status, body, _ := postJSON(t, client, base+"/rerun", origin, "", rerun, csrf)
		var got task.Record
		if err := json.Unmarshal([]byte(body), &got); err != nil {
			t.Fatal(err)
		}
		if status != 200 || got.TaskID == original.TaskID || got.RerunOfTaskID == nil || *got.RerunOfTaskID != original.TaskID || (i == 1 && got.TaskID != next.TaskID) {
			t.Fatalf("重做: %d %s", status, body)
		}
		next = got
	}
	if countTasks(t, ctx, pool, employee.ID) != 2 || countOutbox(t, ctx, pool, employee.ID) != 2 {
		t.Fatal("核实/重复重做产生额外执行")
	}
	response, err := client.http.Get(base + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var events struct {
		Events []task.Event `json:"events"`
	}
	if err := json.NewDecoder(response.Body).Decode(&events); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, event := range events.Events {
		if event.Resolution != nil {
			found = event.Resolution.Previous.Status == task.StatusCancelled && event.Resolution.Reason == request["reason"] && event.ActorEmployeeID == employee.ID
		}
	}
	if !found {
		t.Fatalf("查询缺少核实依据: %+v", events)
	}
	assertNoSecrets(t, "核实日志", logs.String(), "private-task-description", "private-review-summary", "private-review-reason", "private-review-evidence", "private-rerun-reason", "private-commit-error")
}
