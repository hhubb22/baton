package plane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"

	"baton/internal/task"
	"github.com/google/uuid"
)

// TestPlaneLiveWriteback 只在 Baton Test 项目创建、回写并删除本次测试工单。
func TestPlaneLiveWriteback(t *testing.T) {
	if os.Getenv("BATON_PLANE_LIVE") != "1" {
		t.Skip("真实 Plane 回写需显式启用与 Baton Test 访问权限")
	}
	secret := func(field string) string {
		t.Helper()
		out, err := exec.Command("op", "read", "op://Baton Test/plane/"+field).Output()
		if err != nil {
			t.Fatal("无法读取已授权的 Plane 测试凭据")
		}
		return strings.TrimSpace(string(out))
	}
	f := newFixture(t)
	_, accepted := f.send(f.event("updated", "state"), uuid.NewString())
	if accepted.TaskID == "" {
		t.Fatal("未接受测试任务")
	}
	cfg := f.cfg
	cfg.URL = secret("PLANE_URL")
	cfg.APIKey = secret("PLANE_API_TOKEN")
	cfg.WorkspaceSlug = secret("PLANE_WORKSPACE_SLUG")
	cfg.ProjectID = secret("PLANE_PROJECT_ID")
	cfg.BatonURL = "https://baton.example.test"
	c := newClient(cfg, nil)
	ctx := context.Background()
	var project struct {
		ID        string `json:"id"`
		Workspace string `json:"workspace"`
		Name      string `json:"name"`
	}
	if err := c.get(ctx, c.prefix(), &project); err != nil || project.ID != cfg.ProjectID || project.Name != "Baton Test" {
		t.Fatal("无法确认 Baton Test 测试项目")
	}
	cfg.WorkspaceID = project.Workspace
	c = newClient(cfg, nil)
	var version struct {
		Instance struct {
			CurrentVersion string `json:"current_version"`
		} `json:"instance"`
	}
	if err := c.get(ctx, "/api/instances/", &version); err != nil || version.Instance.CurrentVersion != "1.4.2" {
		t.Fatal("测试 Plane 版本不符")
	}
	mutate := func(path, method string, in any, out any) {
		t.Helper()
		raw, _ := json.Marshal(in)
		r, err := http.NewRequest(method, strings.TrimRight(cfg.URL, "/")+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal("测试请求无效")
		}
		r.Header.Set("X-API-Key", cfg.APIKey)
		r.Header.Set("Content-Type", "application/json")
		resp, err := c.http.Do(r)
		if err != nil {
			t.Fatal("测试 Plane 请求失败")
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 && resp.StatusCode != 201 && resp.StatusCode != 204 {
			t.Fatalf("测试 Plane 请求状态 %d", resp.StatusCode)
		}
		if out != nil {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal("测试 Plane 响应无效")
			}
		}
	}
	var created struct {
		ID string `json:"id"`
	}
	mutate(c.prefix()+"issues/", http.MethodPost, map[string]string{"name": "baton-t27-" + uuid.NewString(), "description_html": "<p>PS-131 隔离测试</p>", "external_source": "baton-test", "external_id": uuid.NewString()}, &created)
	if _, err := uuid.Parse(created.ID); err != nil {
		t.Fatal("测试工单标识无效")
	}
	t.Cleanup(func() { mutate(c.prefix()+"issues/"+created.ID+"/", http.MethodDelete, nil, nil) })
	if _, err := f.pool.Exec(ctx, `INSERT INTO plane_issues(webhook_id,project_id,issue_id) VALUES($1,$2,$3)`, cfg.WebhookID, cfg.ProjectID, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE plane_triggers SET project_id=$2,issue_id=$3 WHERE task_id=$1`, accepted.TaskID, cfg.ProjectID, created.ID); err != nil {
		t.Fatal(err)
	}
	var lost, unavailable atomic.Bool
	lost.Store(true)
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if unavailable.Load() {
			return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		resp, err := http.DefaultTransport.RoundTrip(r)
		if err == nil && r.Method == http.MethodPost && resp.StatusCode == 201 && lost.Swap(false) {
			_ = resp.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return resp, err
	})
	var err error
	f.cfg = cfg
	f.svc, err = New(f.pool, cfg, f.repo, transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	flushWriteback(t, f)
	var delivered int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM plane_outbox WHERE delivered_at IS NOT NULL`).Scan(&delivered); err != nil || delivered != 0 {
		t.Fatal("丢失响应被错误确认")
	}
	rows, err := list[comment](ctx, c, c.prefix()+"issues/"+created.ID+"/comments/")
	if err != nil || len(rows) != 1 {
		t.Fatal("Plane 未保存首次评论")
	}
	writebackDue(t, f)
	flushWriteback(t, f)
	if _, err := f.repo.RequestCancel(ctx, cfg.Actors[0].EmployeeID, accepted.TaskID); err != nil {
		t.Fatal(err)
	}
	unavailable.Store(true)
	flushWriteback(t, f)
	unavailable.Store(false)
	writebackDue(t, f)
	flushWriteback(t, f)
	rec, err := f.repo.GetTask(ctx, cfg.Actors[0].EmployeeID, accepted.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.ResolveTask(ctx, cfg.Actors[0].EmployeeID, accepted.TaskID, task.ResolveInput{ExpectedVersion: rec.Version, Status: task.StatusCompleted, Summary: "测试结果已核实", Reason: "隔离测试", EvidenceEmptyReason: "未执行模型"}); err != nil {
		t.Fatal(err)
	}
	flushWriteback(t, f)
	rec, err = f.repo.GetTask(ctx, cfg.Actors[0].EmployeeID, accepted.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	a, err := f.repo.AcceptResult(ctx, cfg.Actors[0].EmployeeID, accepted.TaskID, task.AcceptanceInput{ExpectedVersion: rec.Version, Decision: "passed", Comment: "测试员工单独验收"})
	if err != nil {
		t.Fatal(err)
	}
	flushWriteback(t, f)
	rows, err = list[comment](ctx, c, c.prefix()+"issues/"+created.ID+"/comments/")
	if err != nil || len(rows) != 4 {
		t.Fatalf("评论数量 %d %v", len(rows), err)
	}
	seen := map[string]bool{}
	pending, reviewed := false, false
	for _, row := range rows {
		if seen[row.ExternalID] || row.Access != "INTERNAL" || row.ExternalSource != "baton" {
			t.Fatal("真实评论去重或可见性错误")
		}
		seen[row.ExternalID] = true
		pending = pending || strings.Contains(row.HTML, "待员工验收")
		reviewed = reviewed || (strings.Contains(row.HTML, "员工验收通过") && strings.Contains(row.HTML, a.EmployeeID))
	}
	if !pending || !reviewed {
		t.Fatal("成功与员工验收未分别回写")
	}
	f.assertTasks(1)
	t.Log("真实 Plane 1.4.2：POST 成功后丢弃响应、同标记查询恢复、短时 503、成功待验收与员工独立验收均通过；4 条唯一 INTERNAL 评论，1 份任务与执行记录。未运行真实模型。")
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
