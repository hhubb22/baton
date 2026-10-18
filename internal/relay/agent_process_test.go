package relay_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agentcli"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/session"
	"baton/internal/store"
	"baton/internal/task"
)

func TestAgentCLIDelegatesBetweenTwoNodes(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_EXECUTOR_SCRIPT": "running", "BATON_TEST_START_GATE": gate})
	ctx := context.Background()
	releasePrepared := func(taskID string) {
		t.Helper()
		executionID := waitGateFile(t, gate)
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			var prepared bool
			if err := st.pool.QueryRow(ctx, `SELECT prepared_at IS NOT NULL FROM executions WHERE id = $1::uuid AND task_id = $2::uuid`, executionID, taskID).Scan(&prepared); err != nil {
				t.Fatal(err)
			}
			if prepared {
				releaseGate(t, gate, executionID)
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("中心尚未保存准备事实")
	}
	var source task.Record
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{
		"request_id": "agent-source", "description": "委托来源", "authorization_scope": "只读现场信息",
	}, st.csrf, &source); code != http.StatusOK {
		t.Fatalf("来源任务接受失败: %d", code)
	}
	releasePrepared(source.TaskID)
	waitTaskStatus(t, st, source.TaskID, task.StatusRunning)
	var sourceSession, sourceExecution string
	if err := st.pool.QueryRow(ctx, `SELECT t.target_session_id::text, e.id::text FROM tasks t JOIN executions e ON e.task_id = t.id WHERE t.id = $1::uuid`, source.TaskID).Scan(&sourceSession, &sourceExecution); err != nil {
		t.Fatal(err)
	}
	firstWorker := workerStatus(t, st.dataDir, sourceSession)
	t.Cleanup(func() { stopWorker(firstWorker.PID) })
	contextFile, err := session.AgentContextPath(st.dataDir, sourceSession, sourceExecution)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(contextFile)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("上下文文件未受限")
	}
	cli := filepath.Join(t.TempDir(), "baton")
	build := exec.Command("go", "build", "-o", cli, "./cmd/baton")
	build.Dir = filepath.Join("..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建 CLI: %v %s", err, out)
	}
	invoke := func(contextPath string, success bool, args ...string) []byte {
		t.Helper()
		callCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
		defer cancel()
		cmd := exec.CommandContext(callCtx, cli, args...)
		cmd.Env = childEnv(map[string]string{agentcli.ContextEnv: contextPath})
		out, err := cmd.CombinedOutput()
		if (err == nil) != success {
			t.Fatalf("CLI %v: %v %s", args, err, out)
		}
		return out
	}
	request := filepath.Join(t.TempDir(), "request.json")
	writeRequest := func(value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(request, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	target := registerAgent(t, st.client, st.base, st.csrf, "Target", []string{"pi", "start"})
	if _, err := st.pool.Exec(ctx, `UPDATE nodes SET default_agent_type = 'pi' WHERE id = $1::uuid`, target.NodeID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.pool.Exec(ctx, `UPDATE employee_settings SET default_pc_node_id = $1::uuid WHERE employee_id = $2::uuid`, target.NodeID, st.employeeID); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"request_id": "agent-child", "description": "读取目标信息"}
	writeRequest(input)
	var child task.Record
	if err := json.Unmarshal(invoke(contextFile, true, "delegate", "--request-file", request, "--json"), &child); err != nil {
		t.Fatal(err)
	}
	if child.TaskID == "" || child.TargetNodeID != target.NodeID || child.ParentTaskID == nil || *child.ParentTaskID != source.TaskID || child.SourceSessionID == nil || *child.SourceSessionID != sourceSession || child.AuthorizationScope == nil || *child.AuthorizationScope != "只读现场信息" {
		t.Fatalf("委托关联错误: %+v", child)
	}
	var waiting struct {
		TaskID   string      `json:"task_id"`
		TimedOut bool        `json:"timed_out"`
		Waiting  bool        `json:"waiting"`
		Task     task.Record `json:"task"`
	}
	started := time.Now()
	if err := json.Unmarshal(invoke(contextFile, true, "task", "wait", child.TaskID, "--timeout", "350ms", "--json"), &waiting); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 3*time.Second || !waiting.Waiting || !waiting.TimedOut || waiting.TaskID != child.TaskID || waiting.Task.Status != task.StatusQueued {
		t.Fatalf("有限等待不正确: %+v", waiting)
	}
	var again task.Record
	if err := json.Unmarshal(invoke(contextFile, true, "delegate", "--request-file", request, "--json"), &again); err != nil || again.TaskID != child.TaskID {
		t.Fatalf("重试不是原任务: %+v %v", again, err)
	}
	input["description"] = "修改请求内容"
	writeRequest(input)
	if out := invoke(contextFile, false, "delegate", "--request-file", request, "--json"); !strings.Contains(string(out), "conflict") {
		t.Fatal("未拒绝同 ID 冲突")
	}
	for _, forged := range []map[string]any{
		{"employee_id": st.employeeID}, {"source_session_id": source.TaskID}, {"parent_task_id": child.TaskID}, {"authorization_scope": "写入所有节点"},
	} {
		forged["request_id"], forged["description"] = "forged", "拒绝伪造"
		writeRequest(forged)
		invoke(contextFile, false, "delegate", "--request-file", request, "--json")
	}
	// 直接调用中心存储也不能把另一个员工或节点的执行当作来源。
	center := store.New(st.pool)
	trusted := store.AgentSource{EmployeeID: st.employeeID, NodeID: st.ident.NodeID, TaskID: source.TaskID, SessionID: sourceSession, ExecutionID: sourceExecution}
	otherID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	for _, forged := range []store.AgentSource{
		{EmployeeID: otherID, NodeID: st.ident.NodeID, TaskID: source.TaskID, SessionID: sourceSession, ExecutionID: sourceExecution},
		{EmployeeID: st.employeeID, NodeID: target.NodeID, TaskID: source.TaskID, SessionID: sourceSession, ExecutionID: sourceExecution},
		{EmployeeID: st.employeeID, NodeID: st.ident.NodeID, TaskID: source.TaskID, SessionID: sourceSession, ExecutionID: otherID},
	} {
		if _, err := center.AgentTask(ctx, forged, child.TaskID); err == nil {
			t.Fatal("中心信任了伪造来源")
		}
	}
	var count, executions int
	var cancelled bool
	if err := st.pool.QueryRow(ctx, `SELECT COUNT(*), (SELECT COUNT(*) FROM executions WHERE task_id = $1::uuid), bool_or(cancel_requested_at IS NOT NULL) FROM tasks WHERE id = $1::uuid`, child.TaskID).Scan(&count, &executions, &cancelled); err != nil || count != 1 || executions != 1 || cancelled {
		t.Fatalf("等待重建或取消了委托: %d %d %v %v", count, executions, cancelled, err)
	}
	if current, err := center.AgentTask(ctx, trusted, child.TaskID); err != nil || current.TargetNodeID != target.NodeID || current.Status != task.StatusQueued {
		t.Fatalf("离线任务被改派: %+v %v", current, err)
	}
	writeRequest(map[string]any{"request_id": "agent-cancel", "description": "明确取消的委托"})
	var cancellable task.Record
	if err := json.Unmarshal(invoke(contextFile, true, "delegate", "--request-file", request, "--json"), &cancellable); err != nil {
		t.Fatal(err)
	}
	invoke(contextFile, true, "task", "cancel", cancellable.TaskID, "--json")
	waitTaskStatus(t, st, cancellable.TaskID, task.StatusCancelled)
	invoke(contextFile, false, "task", "get", otherID, "--json")
	// 原凭据不随 batond 重连更换，存活来源 Worker 也不重启。
	st.batond.stop()
	st.batond = startCmd(t, st.batondBin, st.batondArgs, st.batondEnv)
	waitLog(t, st.batond, "event=synced")
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	invoke(contextFile, true, "task", "get", child.TaskID, "--json")
	if status := workerStatus(t, st.dataDir, sourceSession); status.PID != firstWorker.PID || status.ExecutorInputs != 1 {
		t.Fatalf("batond 重启替换了来源: %+v", status)
	}
	targetDir := filepath.Join(t.TempDir(), "target")
	if err := node.WriteIdentity(targetDir, target); err != nil {
		t.Fatal(err)
	}
	targetProc := startCmd(t, st.batondBin, []string{"run", "--relay", "wss://" + st.nodeAddr + "/v1/node", "--data-dir", targetDir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE": st.certFile, "BATON_HEARTBEAT_INTERVAL": "200ms", "BATON_TEST_EXECUTOR_SCRIPT": "success", "BATON_TEST_EXECUTOR_LOG": filepath.Join(targetDir, "executor.log"), "BATON_TEST_START_GATE": gate,
	}))
	_ = targetProc
	releasePrepared(child.TaskID)
	waitTaskStatus(t, st, child.TaskID, task.StatusCompleted)
	var result store.AgentResultView
	if err := json.Unmarshal(invoke(contextFile, true, "task", "result", child.TaskID, "--json"), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Ready || result.TaskID != child.TaskID || result.TargetNodeID != target.NodeID || result.SessionID == nil || result.ExecutionID == "" || result.Summary == nil || *result.Summary != session.SuccessSummary || len(result.Evidence) != 1 || result.Error != nil || result.TaskID == session.ForgedTaskID {
		t.Fatalf("结构化结果错误: %+v", result)
	}
	secondWorker := workerStatus(t, targetDir, *result.SessionID)
	t.Cleanup(func() { stopWorker(secondWorker.PID) })
	if firstWorker.PID == secondWorker.PID || secondWorker.ExecutorInputs != 1 {
		t.Fatal("没有两个独立 Worker")
	}
	var relations []store.AgentRelation
	if err := json.Unmarshal(invoke(contextFile, true, "task", "relations", source.TaskID, "--json"), &relations); err != nil {
		t.Fatal(err)
	}
	if len(relations) != 3 {
		t.Fatalf("关系数量: %d", len(relations))
	}
	var linked bool
	for _, rel := range relations {
		if rel.TaskID == child.TaskID && rel.SourceTaskID != nil && *rel.SourceTaskID == source.TaskID && rel.SourceSessionID != nil && *rel.SourceSessionID == sourceSession && rel.TargetSessionID != nil && *rel.TargetSessionID == *result.SessionID && rel.TargetNodeID == target.NodeID && rel.ExecutionID == result.ExecutionID {
			linked = true
		}
	}
	if !linked {
		t.Fatalf("缺少可信委托关系: %+v", relations)
	}
	invoke(contextFile, true, "task", "get", child.TaskID, "--json")
	invoke(contextFile, true, "task", "wait", child.TaskID, "--timeout", "1s", "--json")
	invoke(contextFile, true, "task", "result", child.TaskID, "--json")
	if status := workerStatus(t, targetDir, *result.SessionID); status.ExecutorInputs != 1 || status.ExecutorStarts != 1 {
		t.Fatalf("查询重跑执行: %+v", status)
	}
}
