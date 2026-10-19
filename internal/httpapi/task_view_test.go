package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/store"
	"baton/internal/task"
)

func TestTaskQueryRecoveryAndIsolation(t *testing.T) {
	pool := dbtest.Open(t)
	srv := httptest.NewTLSServer(newAPI(t, pool, &bytes.Buffer{}))
	defer srv.Close()
	client, other := tlsClient(t, srv), tlsClient(t, srv)
	const password = "query-task-password-001"
	createEmployee(t, pool, "alice", "Alice", password)
	createEmployee(t, pool, "bob", "Bob", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	loginFor(t, other, srv.URL, "bob", password)
	n := registerNode(t, client, srv.URL, csrf, "Desk", "pc", []string{"pi", "start"})
	agent := "pi"
	in := task.Input{RequestID: "original/query+request", Description: "只读恢复", TargetNodeID: &n.NodeID, AgentType: &agent}
	code, body, _ := postJSON(t, client, srv.URL+"/api/v1/tasks", origin, "", in, csrf)
	if code != 200 {
		t.Fatalf("接受: %d %s", code, body)
	}
	var accepted task.Record
	if err := json.Unmarshal([]byte(body), &accepted); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*browser{client, other} {
		response, err := c.http.Get(srv.URL + "/api/v1/tasks?request_id=" + url.QueryEscape(in.RequestID))
		if err != nil {
			t.Fatal(err)
		}
		var page store.TaskPage
		err = json.NewDecoder(response.Body).Decode(&page)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("查询: %d %v", response.StatusCode, err)
		}
		if c == client && (len(page.Tasks) != 1 || page.Tasks[0].TaskID != accepted.TaskID || page.Tasks[0].DeliveryStatus != "not_ready") {
			t.Fatalf("恢复原任务: %+v", page)
		}
		if c == other && len(page.Tasks) != 0 {
			t.Fatal("查询泄露其他员工任务")
		}
	}
	for _, query := range []string{"include_shell=yes", "include_shell=true&include_shell=false", "cursor=bad", "request_id=", "parent_task_id=bad", "unused=true"} {
		response, err := client.http.Get(srv.URL + "/api/v1/tasks?" + query)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode < 400 || response.StatusCode >= 500 {
			t.Fatalf("非法参数 %s: %d", query, response.StatusCode)
		}
	}
	response, err := other.http.Get(srv.URL + "/api/v1/tasks/" + accepted.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	_, _ = data.ReadFrom(response.Body)
	response.Body.Close()
	if response.StatusCode != 403 || strings.Contains(data.String(), in.Description) {
		t.Fatal("详情越权")
	}
}
