//go:build !windows

package gateway_test

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"baton/internal/agent/pi/pireplaytest"
)

func replayPIDs(t *testing.T, binary string) []int {
	t.Helper()
	raw, err := exec.Command("ps", "-axo", "pid=,stat=,comm=").Output()
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && !strings.HasPrefix(fields[1], "Z") && strings.Join(fields[2:], " ") == binary {
			pid, err := strconv.Atoi(fields[0])
			if err != nil {
				t.Fatal(err)
			}
			pids = append(pids, pid)
		}
	}
	return pids
}

func TestThreadAgentProcessLifetime(t *testing.T) {
	for _, mode := range []string{"worker_crash", "test_cleanup"} {
		t.Run(mode, func(t *testing.T) {
			st, fixture, work := startThreadReplayStack(t, pireplaytest.Tape(t, "../agent/pi/testdata/replay", "simple"), "event:agent_settled")
			thread := createBrowserThread(t, st, work, "first message")
			fixture.Wait(t, "event:agent_settled")
			pids := replayPIDs(t, fixture.Binary)
			if len(pids) != 1 {
				t.Fatalf("expected one running replay Agent, found %v", pids)
			}
			// 失败也只回收本测试的进程组，避免回归测试本身留下进程。
			group, err := syscall.Getpgid(pids[0])
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if len(replayPIDs(t, fixture.Binary)) > 0 {
					_ = syscall.Kill(-group, syscall.SIGKILL)
				}
			})
			worker := workerStatus(t, st.dataDir, thread.ID)
			st.batond.stop()
			switch mode {
			case "worker_crash":
				stopWorker(worker.PID)
			case "test_cleanup":
				if err := cleanupSessionWorkers(st.dataDir); err != nil {
					t.Fatal(err)
				}
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				remaining := replayPIDs(t, fixture.Binary)
				if len(remaining) == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("Agent survived %s: pids=%v", mode, remaining)
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
	}
}
