package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"baton/internal/fileaccess"
	"baton/internal/protocol"
	"baton/internal/task"
)

func TestWorkerRechecksArtifactsBeforeSubmittingInput(t *testing.T) {
	for _, change := range []string{"deleted", "other_node", "permissions", "available"} {
		t.Run(change, func(t *testing.T) {
			if change == "permissions" && runtime.GOOS == "windows" {
				t.Skip("POSIX 模式位不能验证 Windows ACL")
			}
			w, _, sessionID := clockWorker(t, 120)
			w.dataDir = t.TempDir()
			root := t.TempDir()
			file := filepath.Join(root, "firmware.bin")
			if err := os.WriteFile(file, []byte("FIRMWARE"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := fileaccess.AddBrowseRoot(w.dataDir, "build", root); err != nil {
				t.Fatal(err)
			}
			ref := task.ArtifactRef{NodeID: w.nodeID, RootID: "build", Path: "firmware.bin"}
			if _, reason := fileaccess.CheckArtifacts(w.dataDir, w.nodeID, []task.ArtifactRef{ref}); reason != "" {
				t.Fatal(reason)
			}
			switch change {
			case "deleted":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			case "other_node":
				ref.NodeID = mustSessionID(t)
			case "permissions":
				if err := os.Chmod(file, 0); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(file, 0o600) })
			}
			raw, err := task.MarshalExecutorInput("使用产物", nil, nil, nil, nil, 1, []task.ArtifactRef{ref})
			if err != nil {
				t.Fatal(err)
			}
			reports, err := w.SubmitInput(sessionID, string(raw))
			if err != nil {
				t.Fatal(err)
			}
			if change == "available" {
				if w.observer.Inputs() != 1 {
					t.Fatal("可用引用未执行")
				}
				return
			}
			if w.observer.Inputs() != 0 || w.inputSubmitted {
				t.Fatal("不可用引用仍向执行器提交输入")
			}
			var result *task.Candidate
			for _, report := range reports {
				var body protocol.ExecutionReport
				if err := json.Unmarshal(report.Body, &body); err != nil {
					t.Fatal(err)
				}
				if body.Kind == protocol.ReportResult {
					result = &task.Candidate{Status: body.Status, Summary: body.Summary, Artifacts: body.Artifacts,
						EvidenceEmptyReason: body.EvidenceEmptyReason, ErrorCode: body.ErrorCode, ErrorMessage: body.ErrorMessage}
				}
			}
			if result == nil || result.ErrorCode != task.CodeArtifactUnavailable || len(result.Artifacts) != 1 || result.Artifacts[0].AccessStatus != task.AccessUnavailable {
				t.Fatalf("缺少结构化不可用结果: %+v", result)
			}
			if err := task.ValidateCandidate(*result); err != nil {
				t.Fatal(err)
			}
			if _, err := w.SubmitInput(sessionID, string(raw)); err != nil || w.observer.Inputs() != 0 {
				t.Fatal("重复提交启动了依赖步骤", err)
			}
		})
	}
}
