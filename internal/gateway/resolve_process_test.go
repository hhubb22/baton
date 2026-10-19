package gateway_test

import (
	"testing"

	"baton/internal/task"
)

func TestManualResolveAndRerunHaveExplicitExecutionCounts(t *testing.T) {
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_ABORT_SCRIPT": "unknown"})
	original := acceptTask(t, st, "manual-original")
	base := st.base + "/api/v1/tasks/" + original.TaskID
	waitTaskStatus(t, st, original.TaskID, task.StatusRunning)
	if code := postJSON(t, st.client, base+"/cancel", map[string]any{}, st.csrf, nil); code != 200 {
		t.Fatalf("取消: %d", code)
	}
	unverified := waitStopEvidence(t, st, original.TaskID)
	if unverified.Status != task.StatusNeedsVerification {
		t.Fatalf("前提不是副作用未定: %+v", unverified)
	}
	rerun := task.RerunInput{RequestID: "manual-rerun", ExpectedVersion: unverified.Version, Reason: "明确发起新的任务"}
	if code := postJSON(t, st.client, base+"/rerun", rerun, st.csrf, nil); code != 409 {
		t.Fatalf("未确认副作用也允许重做: %d", code)
	}
	var resolved task.Record
	if code := postJSON(t, st.client, base+"/resolve", task.ResolveInput{
		ExpectedVersion: unverified.Version, Status: task.StatusCompleted,
		Summary: "员工核对外部状态后确认已完成", Reason: "已人工核对",
		Evidence: []task.ResultRef{{StorageRef: "inspection", ResourceID: "check-1", AccessStatus: "available"}},
	}, st.csrf, &resolved); code != 200 || resolved.Status != task.StatusCompleted {
		t.Fatalf("核实: %d %+v", code, resolved)
	}
	for i := 0; i < 3; i++ {
		var view task.Record
		if err := getJSON(t, st.client, base, &view); err != nil {
			t.Fatal(err)
		}
		if view.Status != task.StatusCompleted || view.Version != resolved.Version {
			t.Fatalf("查询改变结论: %+v", view)
		}
	}
	if n := executorCount(t, st, "input"); n != 1 {
		t.Fatalf("核实或查询重跑了执行: %d", n)
	}
	rerun.ExpectedVersion = resolved.Version
	var next task.Record
	if code := postJSON(t, st.client, base+"/rerun", rerun, st.csrf, &next); code != 200 || next.TaskID == original.TaskID || next.RerunOfTaskID == nil || *next.RerunOfTaskID != original.TaskID {
		t.Fatalf("显式重做: %d %+v", code, next)
	}
	waitExecutor(t, st, "start\ninput\nabort\nstart\ninput\n")
	waitTaskStatus(t, st, next.TaskID, task.StatusRunning)
	if taskWorker(t, st, original.TaskID) == taskWorker(t, st, next.TaskID) {
		t.Fatal("重做复用了原 Session")
	}
	for i := 0; i < 3; i++ {
		var replay task.Record
		if code := postJSON(t, st.client, base+"/rerun", rerun, st.csrf, &replay); code != 200 || replay.TaskID != next.TaskID {
			t.Fatalf("重试重复执行: %d %+v", code, replay)
		}
	}
	if n := executorCount(t, st, "input"); n != 2 {
		t.Fatalf("显式重做没有恰好增加一次输入: %d", n)
	}
	if status, executions, _ := taskFacts(t, st, original.TaskID); status != task.StatusCompleted || executions != 1 {
		t.Fatalf("改写了原执行: %s %d", status, executions)
	}
}
