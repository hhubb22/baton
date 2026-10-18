package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/task"
)

func TestEmployeeAcceptanceAuthenticationAndAudit(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	logs := &bytes.Buffer{}
	srv := httptest.NewTLSServer(newAPI(t, pool, logs))
	defer srv.Close()
	client, other := tlsClient(t, srv), tlsClient(t, srv)
	const password = "acceptance-flow-password-001"
	employee := createEmployee(t, pool, "alice", "Alice", password)
	createEmployee(t, pool, "bob", "Bob", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	otherCSRF := loginFor(t, other, srv.URL, "bob", password)
	node := registerNode(t, client, srv.URL, csrf, "Desk", "pc", []string{"pi", "start"})
	setNodeAgent(t, ctx, pool, node.NodeID, "pi")
	status, body, _ := postJSON(t, client, srv.URL+"/api/v1/tasks", origin, "", map[string]any{"request_id": "acceptance", "description": "private-description"}, csrf)
	var rec task.Record
	if err := json.Unmarshal([]byte(body), &rec); err != nil || status != 200 {
		t.Fatalf("任务 %d %v", status, err)
	}
	url := srv.URL + "/api/v1/tasks/" + rec.TaskID + "/acceptance"
	request := task.AcceptanceInput{ExpectedVersion: rec.Version, Decision: "passed", Comment: "private-review-comment"}
	if status, _, _ := postJSON(t, tlsClient(t, srv), url, origin, "", request); status != 401 {
		t.Fatalf("未登录 %d", status)
	}
	if status, _, _ := postJSON(t, client, url, origin, "", request); status != 403 {
		t.Fatalf("无 CSRF %d", status)
	}
	if status, _, _ := postJSON(t, other, url, origin, "", request, otherCSRF); status != 403 {
		t.Fatalf("越权 %d", status)
	}
	if status, _, _ := postJSON(t, client, url, origin, "", request, csrf); status != 409 {
		t.Fatalf("排队任务验收 %d", status)
	}
	if status, _, _ := postJSON(t, client, strings.TrimSuffix(url, "/acceptance")+"/cancel", origin, "", map[string]any{}, csrf); status != 200 {
		t.Fatalf("取消 %d", status)
	}
	rec = storedTask(t, ctx, pool, employee.ID, "acceptance")
	if err := pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, rec.TaskID).Scan(&rec.Version); err != nil {
		t.Fatal(err)
	}
	request.ExpectedVersion = rec.Version
	if status, _, _ := postJSON(t, client, url+"?unused=true", origin, "", request, csrf); status != 400 {
		t.Fatalf("查询参数 %d", status)
	}
	invalid := request
	invalid.Decision = "completed"
	if status, _, _ := postJSON(t, client, url, origin, "", invalid, csrf); status != 400 {
		t.Fatalf("错误结论 %d", status)
	}
	status, body, _ = postJSON(t, client, url, origin, "", request, csrf)
	var acceptance task.Acceptance
	if err := json.Unmarshal([]byte(body), &acceptance); err != nil || status != 200 || acceptance.EmployeeID != employee.ID || acceptance.Comment != request.Comment {
		t.Fatalf("验收 %d %v", status, err)
	}
	if status, _, _ := postJSON(t, client, url, origin, "", request, csrf); status != 409 {
		t.Fatalf("重复旧版本 %d", status)
	}
	response, err := client.http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Acceptances []task.Acceptance `json:"acceptances"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil || len(result.Acceptances) != 1 {
		t.Fatalf("验收审计 %v", err)
	}
	response2, err := other.http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response2.Body.Close()
	if response2.StatusCode != 403 {
		t.Fatalf("越权读取 %d", response2.StatusCode)
	}
	assertNoSecrets(t, "验收日志", logs.String(), "private-review-comment", "private-description")
}
