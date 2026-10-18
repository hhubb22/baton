package task_test

import (
	"strings"
	"testing"

	"baton/internal/task"
)

func TestValidateManualResolution(t *testing.T) {
	valid := task.ResolveInput{ExpectedVersion: 1, Status: task.StatusCompleted, Summary: "核实完成", Reason: "人工检查", EvidenceEmptyReason: "证据保存在设备现场"}
	if err := task.ValidateResolve(valid); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*task.ResolveInput){
		"version":          func(in *task.ResolveInput) { in.ExpectedVersion = 0 },
		"status":           func(in *task.ResolveInput) { in.Status = task.StatusNeedsVerification },
		"summary":          func(in *task.ResolveInput) { in.Summary = " " },
		"summary-limit":    func(in *task.ResolveInput) { in.Summary = strings.Repeat("字", 4001) },
		"reason":           func(in *task.ResolveInput) { in.Reason = " " },
		"reason-limit":     func(in *task.ResolveInput) { in.Reason = strings.Repeat("字", 401) },
		"reason-control":   func(in *task.ResolveInput) { in.Reason = "错误\n理由" },
		"missing-evidence": func(in *task.ResolveInput) { in.EvidenceEmptyReason = "" },
		"invalid-evidence": func(in *task.ResolveInput) {
			in.Evidence = []task.ResultRef{{ResourceID: "no-location", AccessStatus: task.AccessAvailable}}
			in.EvidenceEmptyReason = ""
		},
		"mixed-evidence": func(in *task.ResolveInput) {
			in.Evidence = []task.ResultRef{{StorageRef: "inspection", ResourceID: "check", AccessStatus: task.AccessAvailable}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			in := valid
			change(&in)
			if err := task.ValidateResolve(in); err == nil {
				t.Fatal("接受了无效核实请求")
			}
		})
	}
	for _, status := range []string{task.StatusFailed, task.StatusCancelled} {
		in := valid
		in.Status = status
		if err := task.ValidateResolve(in); err != nil {
			t.Fatal(err)
		}
	}
	for _, in := range []task.RerunInput{
		{RequestID: "", ExpectedVersion: 1, Reason: "重新执行"},
		{RequestID: "rerun", ExpectedVersion: 0, Reason: "重新执行"},
		{RequestID: "rerun", ExpectedVersion: 1, Reason: " "},
	} {
		if err := task.ValidateRerun(in); err == nil {
			t.Fatal("接受了无效重做请求")
		}
	}
}
