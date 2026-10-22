package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/node"
	"baton/internal/task"
)

func TestDefaultDeviceRoutesToLegacyUbuntuNode(t *testing.T) {
	t.Parallel()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0"})
	target := registerAgent(t, st.client, st.base, st.csrf, "Ubuntu", []string{"pi", "start"}, "ubuntu")
	// 旧身份文件在重连时仍会发送 ubuntu，中心忽略该兼容字段。
	target.Role = "ubuntu"
	dir := filepath.Join(t.TempDir(), "ubuntu")
	if err := node.WriteIdentity(dir, target); err != nil {
		t.Fatal(err)
	}
	if _, err := st.pool.Exec(context.Background(), `UPDATE nodes SET default_agent_type='pi' WHERE id=$1::uuid`, target.NodeID); err != nil {
		t.Fatal(err)
	}
	var saved node.SavedDefault
	if status := postDefaultDevice(t, st, target.NodeID, &saved); status != 200 || saved.NodeID != target.NodeID || saved.LegacyNodeID != target.NodeID {
		t.Fatalf("保存默认设备失败: %d %+v", status, saved)
	}
	queued := acceptTask(t, st, "ubuntu-default-offline")
	if queued.TargetNodeID != target.NodeID {
		t.Fatalf("离线时改派了任务: %+v", queued)
	}
	proc := startCmd(t, st.batondBin, []string{"run", "--relay", "wss://" + st.nodeAddr + "/v1/node", "--data-dir", dir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE": st.certFile, "BATON_HEARTBEAT_INTERVAL": "200ms",
		"BATON_TEST_EXECUTOR_LOG": filepath.Join(dir, "executor.log"), "BATON_TEST_HOLD_START": "0",
	}))
	waitNode(t, st.client, st.base, target.NodeID, true, true, true)
	targetStack := *st
	targetStack.dataDir = dir
	targetStack.batond = proc
	waitExecutor(t, &targetStack, "start\ninput\n")
	waitTaskStatus(t, st, queued.TaskID, task.StatusRunning)
	worker := workerStatus(t, dir, sessionOf(t, st, queued.TaskID))
	t.Cleanup(func() {
		proc.stop()
		stopWorker(worker.PID)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if processAlive(worker.PID) != nil {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Error("测试 Worker 未退出")
	})
	if executorCount(t, st, "input") != 0 {
		t.Fatal("任务在原默认节点执行")
	}
	if executorCount(t, &targetStack, "input") != 1 {
		t.Fatal("默认设备重复执行任务")
	}
}

func postDefaultDevice(t *testing.T, st *prepareStack, target string, saved *node.SavedDefault) int {
	t.Helper()
	body, err := json.Marshal(map[string]string{"node_id": target})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPut, st.base+"/api/v1/me/default-device", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://baton.example")
	req.Header.Set("X-CSRF-Token", st.csrf)
	resp, err := st.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(saved); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode
}
