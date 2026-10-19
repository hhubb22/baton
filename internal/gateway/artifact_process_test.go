package gateway_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/node"
	"baton/internal/task"
)

func TestArtifactsAcrossTwoNodesBlockUnavailableInputs(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START": "0", "BATON_TEST_EXECUTOR_SCRIPT": "success", "BATON_TEST_START_GATE": gate,
	})
	ctx := context.Background()
	other := registerAgent(t, st.client, st.base, st.csrf, "Artifact target", []string{"pi", "start"})
	otherDir := filepath.Join(t.TempDir(), "node")
	if err := node.WriteIdentity(otherDir, other); err != nil {
		t.Fatal(err)
	}
	if _, err := st.pool.Exec(ctx, `UPDATE nodes SET default_agent_type = 'pi' WHERE id = $1::uuid`, other.NodeID); err != nil {
		t.Fatal(err)
	}
	otherProc := startCmd(t, st.batondBin, []string{"run", "--relay", "wss://" + st.nodeAddr + "/v1/node", "--data-dir", otherDir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE": st.certFile, "BATON_HEARTBEAT_INTERVAL": "200ms", "BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_EXECUTOR_LOG": filepath.Join(otherDir, "executor.log"), "BATON_TEST_START_GATE": gate,
	}))
	waitNode(t, st.client, st.base, other.NodeID, true, true, true)
	waitLog(t, otherProc, "event=synced")
	roots := []string{t.TempDir(), t.TempDir()}
	for i, dir := range []string{st.dataDir, otherDir} {
		if err := node.AddBrowseRoot(dir, "build", roots[i]); err != nil {
			t.Fatal(err)
		}
		file, err := os.Create(filepath.Join(roots[i], "firmware.bin"))
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(64 << 20); err != nil {
			t.Fatal(err)
		}
		_ = file.Close()
	}
	if err := os.WriteFile(filepath.Join(roots[1], "private.bin"), []byte("PRIVATE"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(roots[1], "private.bin"), 0o600) })
	create := func(id, target string, ref task.ArtifactRef) task.Record {
		t.Helper()
		var got task.Record
		if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{
			"request_id": id, "description": "使用产物", "target_node_id": target, "required_artifacts": []task.ArtifactRef{ref},
		}, st.csrf, &got); code != http.StatusOK {
			t.Fatalf("接受任务: %d", code)
		}
		if len(got.RequiredArtifacts) != 1 || got.RequiredArtifacts[0] != ref {
			t.Fatalf("所需产物未持久化: %+v", got)
		}
		return got
	}
	prepared := func(id string) (string, string) {
		t.Helper()
		execution := waitGateFile(t, gate)
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			var session string
			var ready bool
			if err := st.pool.QueryRow(ctx, `SELECT COALESCE(t.target_session_id::text, ''), e.prepared_at IS NOT NULL FROM tasks t JOIN executions e ON e.task_id = t.id WHERE t.id = $1::uuid AND e.id = $2::uuid`, id, execution).Scan(&session, &ready); err == nil && ready && session != "" {
				return execution, session
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("门闩出现后中心未确认准备事实")
		return "", ""
	}
	// 两个节点均能打开自己的真实大文件，但不能把对方的引用解释成本机文件。
	for i, ident := range []node.Identity{st.ident, other} {
		ref := task.ArtifactRef{NodeID: ident.NodeID, RootID: "build", Path: "firmware.bin"}
		created := create("local-"+ident.NodeID, ident.NodeID, ref)
		execution, session := prepared(created.TaskID)
		releaseGate(t, gate, execution)
		waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
		dir := []string{st.dataDir, otherDir}[i]
		status := workerStatus(t, dir, session)
		t.Cleanup(func() { stopWorker(status.PID) })
		if status.ExecutorInputs != 1 {
			t.Fatalf("本机产物未执行: %+v", status)
		}
	}
	for _, tc := range []struct{ name, owner, root, path, reason string }{
		{"other-node", st.ident.NodeID, "build", "firmware.bin", "other_node:"},
		{"missing", other.NodeID, "build", "missing.bin", "not_found:"},
		{"unauthorized", other.NodeID, "secret", "firmware.bin", "root_forbidden:"},
		{"permissions", other.NodeID, "build", "private.bin", "没有权限"},
		{"escape", other.NodeID, "build", "../firmware.bin", "path_escaped:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "permissions" && runtime.GOOS == "windows" {
				t.Skip("POSIX 模式位不能验证 Windows ACL")
			}
			created := create(tc.name, other.NodeID, task.ArtifactRef{NodeID: tc.owner, RootID: tc.root, Path: tc.path})
			waitTaskStatus(t, st, created.TaskID, task.StatusFailed)
			var view task.Record
			if err := getJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID, &view); err != nil {
				t.Fatal(err)
			}
			if view.ErrorCode == nil || *view.ErrorCode != task.CodeArtifactUnavailable || view.ErrorMessage == nil || !strings.Contains(*view.ErrorMessage, tc.reason) || view.TargetSessionID != nil {
				t.Fatalf("不可用产物未在绑定 Worker 前阻止: %+v", view)
			}
		})
	}
	created := create("removed-after-prepare", other.NodeID, task.ArtifactRef{NodeID: other.NodeID, RootID: "build", Path: "firmware.bin"})
	execution, session := prepared(created.TaskID)
	if err := os.Remove(filepath.Join(roots[1], "firmware.bin")); err != nil {
		t.Fatal(err)
	}
	releaseGate(t, gate, execution)
	waitTaskStatus(t, st, created.TaskID, task.StatusFailed)
	var view task.Record
	if err := getJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID, &view); err != nil {
		t.Fatal(err)
	}
	status := workerStatus(t, otherDir, session)
	t.Cleanup(func() { stopWorker(status.PID) })
	if view.ErrorCode == nil || *view.ErrorCode != task.CodeArtifactUnavailable || len(view.Artifacts) != 1 || view.Artifacts[0].AccessStatus != task.AccessUnavailable || status.ExecutorInputs != 0 || status.InputSubmitted {
		t.Fatalf("准备后删除未阻止输入: task=%+v worker=%+v", view, status)
	}
	for _, dir := range []string{st.dataDir, otherDir} {
		raw, err := os.ReadFile(filepath.Join(dir, "executor.log"))
		if err != nil || strings.Count(string(raw), "input\n") != 1 {
			t.Fatalf("不可用产物执行了输入: %q %v", raw, err)
		}
	}
}
