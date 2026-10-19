package gateway_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/node"
	"baton/internal/store"
	"baton/internal/task"
)

func TestChildDeliveryAcrossWorkersAndCrashWindows(t *testing.T) {
	for _, point := range []string{"", "source_stopped", "delivery_received", "delivery_intent", "delivery_send", "delivery_saved"} {
		name := point
		if name == "" {
			name = "duplicate"
		}
		t.Run(name, func(t *testing.T) {
			st := startPrepareStack(t, map[string]string{
				"BATON_TEST_HOLD_START": "0", "BATON_TEST_EXECUTOR_SCRIPT": "candidate_waiting",
				"BATON_TEST_DELIVERY_SCRIPT": "success", "BATON_TEST_CRASH_AFTER": point,
			})
			parent := acceptTask(t, st, "parent-delivery")
			waitTaskStatus(t, st, parent.TaskID, task.StatusRunning)
			sid := sessionOf(t, st, parent.TaskID)
			first := workerStatus(t, st.dataDir, sid)

			repo := store.New(st.pool)
			source := store.AgentSource{EmployeeID: st.employeeID, NodeID: st.ident.NodeID, TaskID: parent.TaskID, SessionID: sid, ExecutionID: first.ExecutionID}
			target := registerAgent(t, st.client, st.base, st.csrf, "Child", []string{"pi"})
			agentType := "pi"
			targetDir := filepath.Join(t.TempDir(), "target")
			if err := node.WriteIdentity(targetDir, target); err != nil {
				t.Fatal(err)
			}
			gate := t.TempDir()
			startCmd(t, st.batondBin, []string{"run", "--relay", "wss://" + st.nodeAddr + "/v1/node", "--data-dir", targetDir}, childEnv(map[string]string{
				"BATON_TLS_CA_FILE": st.certFile, "BATON_HEARTBEAT_INTERVAL": "200ms", "BATON_TEST_EXECUTOR_SCRIPT": "success",
				"BATON_TEST_EXECUTOR_LOG": filepath.Join(targetDir, "executor.log"), "BATON_TEST_START_GATE": gate,
			}))
			waitNode(t, st.client, st.base, target.NodeID, true, true, true)
			child, err := repo.AcceptDelegation(context.Background(), source, task.Input{RequestID: "child-delivery", Description: "子委托", TargetNodeID: &target.NodeID, AgentType: &agentType})
			if err != nil {
				t.Fatal(err)
			}
			execID := waitGateFile(t, gate)
			childSID := waitChildPreparedSession(t, st, child.TaskID)
			second := workerStatus(t, targetDir, childSID)

			if second.PID == first.PID {
				t.Fatal("没有独立 Worker")
			}
			if point == "source_stopped" {
				stopWorker(first.PID)
				waitTaskStatus(t, st, parent.TaskID, task.StatusNeedsVerification)
			}
			releaseGate(t, gate, execID)
			waitTaskStatus(t, st, child.TaskID, task.StatusCompleted)
			expected := "delivered"
			if point == "source_stopped" || point == "delivery_received" {
				expected = "source_stopped"
			}
			if point == "delivery_intent" || point == "delivery_send" {
				expected = "uncertain"
			}
			deliveryID := waitChildDelivery(t, st, source.ExecutionID, expected)
			parentStatus := task.StatusCompleted
			if expected != "delivered" {
				parentStatus = task.StatusNeedsVerification
			}
			waitTaskStatus(t, st, parent.TaskID, parentStatus)
			before := workerStatus(t, st.dataDir, sid)

			// 即使中心/节点重复通知，按 delivery_id 返回同一张账本，不能再注入。
			deliveries, err := repo.ChildDeliveries(context.Background(), source, child.TaskID)
			if err != nil || len(deliveries) != 1 || deliveries[0].DeliveryID != deliveryID {
				t.Fatalf("通知身份: %+v %v", deliveries, err)
			}
			client := dialWorker(t, st.dataDir, sid)
			for range 3 {
				if _, err := client.ReceiveChild(deliveries[0], false); err != nil {
					t.Fatal(err)
				}
			}
			client.Close()
			st.batond.stop()
			st.batond = startCmd(t, st.batondBin, st.batondArgs, st.batondEnv)
			waitLog(t, st.batond, "event=synced")
			waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
			waitChildDelivery(t, st, source.ExecutionID, expected)
			after := workerStatus(t, st.dataDir, sid)
			if after.ExecutorInputs != before.ExecutorInputs || after.ExecutorStarts != before.ExecutorStarts {
				t.Fatalf("重连重启执行: %+v %+v", before, after)
			}
			expectedInputs := 0
			if point == "" || point == "delivery_send" || point == "delivery_saved" {
				expectedInputs = 1
			}
			if got := executorCount(t, st, "delivery:"+deliveryID); got != expectedInputs {
				t.Fatalf("子结果输入 %d，期望 %d", got, expectedInputs)
			}
			if executorCount(t, st, "input") != 1 || executorCount(t, st, "start") != 1 {
				t.Fatal("重发原始输入或重启 Agent")
			}
			childView, err := repo.AgentResult(context.Background(), source, child.TaskID)
			if err != nil || childView.Status != task.StatusCompleted || childView.DeliveryStatus != expected {
				t.Fatalf("交付与执行状态混淆: %+v %v", childView, err)
			}
			if point != "" && after.ExecutorStarts != 0 {
				t.Fatal("恢复时启动了 Agent")
			}
			if raw, err := os.ReadFile(filepath.Join(targetDir, "executor.log")); err != nil || len(raw) == 0 {
				t.Fatalf("子执行缺少历史: %v", err)
			}
		})
	}
}

func waitChildDelivery(t *testing.T, st *prepareStack, sourceExecutionID, expected string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var id, status string
	for time.Now().Before(deadline) {
		err := st.pool.QueryRow(context.Background(), `SELECT id::text, status FROM child_deliveries WHERE source_execution_id = $1::uuid`, sourceExecutionID).Scan(&id, &status)
		if err == nil && status == expected {
			return id
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("子交付未达到 %s，实际 %s；node %s", expected, status, st.batond.out.String())
	return ""
}

func waitChildPreparedSession(t *testing.T, st *prepareStack, taskID string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var sid string
		if err := st.pool.QueryRow(context.Background(), `SELECT t.target_session_id::text FROM tasks t
          JOIN executions e ON e.task_id = t.id WHERE t.id = $1::uuid AND e.prepared_at IS NOT NULL
          AND t.target_session_id IS NOT NULL`, taskID).Scan(&sid); err == nil {
			return sid
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("子任务准备事实尚未写入中心")
	return ""
}
