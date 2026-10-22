package gateway_test

import (
	"os"
	"path/filepath"
	"testing"

	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/protocol"
)

// buildReplayBatond 在整个测试进程内只构建一次测试版 batond。
func buildReplayBatond(t *testing.T) string {
	t.Helper()
	_, binary := buildProjectBins(t)
	return binary
}

func TestRuntimeModelProbeDoesNotConsumeReplayProcess(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	fixture := pireplaytest.New(t, pireplaytest.Build(t, "../../tools/agent-replay"),
		pireplaytest.Tape(t, "../agent/pi/testdata/replay", "simple"),
		dir, newProcessID(t), dir)
	st := startThreadStack(t, map[string]string{"BATON_PI_BIN": fixture.Binary, "BATON_PI_MODEL": pireplaytest.Model})
	waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool {
		for _, a := range r.Agents {
			if a.AgentType == "pi" {
				return a.Status == "available" && len(a.Models) == 0 && a.DefaultModel == ""
			}
		}
		return false
	})
	if raw, err := os.ReadFile(filepath.Join(fixture.Replay.StateDir, "state.json")); !os.IsNotExist(err) {
		t.Fatalf("runtime 探测启动了回放 Agent：state=%s err=%v", raw, err)
	}
}
