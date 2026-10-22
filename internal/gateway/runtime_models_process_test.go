package gateway_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/protocol"
)

// buildReplayBatond 在整个测试进程内只构建一次测试版 batond。
func buildReplayBatond(t *testing.T) string {
	t.Helper()
	replayOnce.Do(func() {
		replayDir, replayErr = os.MkdirTemp("", "baton-replay-batond-*")
		if replayErr != nil {
			return
		}
		binary := filepath.Join(replayDir, "batond.exe")
		cmd := exec.Command("go", "test", "-c", "-o", binary, "./cmd/batond")
		cmd.Dir = filepath.Join("..", "..")
		if out, err := cmd.CombinedOutput(); err != nil {
			replayErr = fmt.Errorf("%w %s", err, out)
			return
		}
		replayBatond = binary
	})
	if replayErr != nil {
		t.Fatalf("构建回放测试 batond：%v", replayErr)
	}
	return replayBatond
}

func TestRuntimeModelProbeDoesNotConsumeReplayProcess(t *testing.T) {
	dir := t.TempDir()
	fixture := pireplaytest.New(t, pireplaytest.Build(t, "../../tools/agent-replay"),
		pireplaytest.Tape(t, "../agent/pi/testdata/replay", "simple"),
		dir, newProcessID(t), dir)
	st := startPrepareStack(t, map[string]string{"BATON_AGENT_DRIVER": "native", "BATON_PI_BIN": fixture.Binary, "BATON_PI_MODEL": pireplaytest.Model})
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
