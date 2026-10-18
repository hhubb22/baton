package store_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"baton/internal/task"
)

func TestRerunRetainsRequiredArtifacts(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	refs := []task.ArtifactRef{{NodeID: in.NodeID, RootID: "build", Path: "firmware.bin"}}
	body, err := json.Marshal(refs)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET required_artifacts = $2::jsonb WHERE id = $1::uuid`, in.TaskID, body); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	if ack, _, err := repo.ApplyExecutionReport(ctx, completedReport(in, mustUUID(t))); err != nil || !ack {
		t.Fatalf("原结果: %v", err)
	}
	previous, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	next, err := repo.RerunTask(ctx, in.EmployeeID, in.TaskID, task.RerunInput{RequestID: "artifact-rerun", ExpectedVersion: previous.Version, Reason: "重新检查固件"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.RequiredArtifacts, refs) {
		t.Fatalf("重做丢失必需产物约束: %+v", next)
	}
	stored, err := repo.GetTask(ctx, in.EmployeeID, next.TaskID)
	if err != nil || !reflect.DeepEqual(stored.RequiredArtifacts, refs) {
		t.Fatalf("重做没有持久化必需产物: %+v %v", stored, err)
	}
}
