//go:build !windows

package session

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/monotime"
	"baton/internal/protocol"
)

type processThreadFake struct {
	*threadFake
	cmd *exec.Cmd
}

func (a *processThreadFake) Send(ctx context.Context, id, text, model string) error {
	a.cmd = exec.Command("/bin/sh", "-c", "/bin/sh -c 'sleep 600 & wait' & wait")
	a.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := a.cmd.Start(); err != nil {
		return err
	}
	return a.threadFake.Send(ctx, id, text, model)
}
func (a *processThreadFake) KillProcessTree() (bool, error) { return killThreadChildren() }

func TestThreadProcessTreeTimeout(t *testing.T) {
	// 独立 Worker 进程使强制停止只影响本测试的 Agent 子进程。
	if os.Getenv("SESSION_THREAD_PROCESS_HELPER") == "1" {
		fake := &threadFake{resume: true, abortCalled: make(chan struct{})}
		done := fake.abortCalled
		w := newThreadTestWorker(t, nil, fake)
		adapter := &processThreadFake{threadFake: fake}
		w.adapter = adapter
		clock := monotime.NewManual(time.Now())
		w.clock = clock
		threadMessage(t, w, "start", "queue")
		defer func() {
			if adapter.cmd != nil {
				_ = syscall.Kill(-adapter.cmd.Process.Pid, syscall.SIGKILL)
				_ = adapter.cmd.Wait()
			}
		}()
		// 等到孙进程已经创建，避免把只杀父进程误当作回收了整个进程树。
		deadline := time.Now().Add(2 * time.Second)
		for {
			processes, err := threadProcesses()
			threadMust(t, err)
			n := 0
			for _, p := range processes {
				if p.group == adapter.cmd.Process.Pid {
					n++
				}
			}
			if n >= 3 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("Agent did not fork grandchildren")
			}
			time.Sleep(10 * time.Millisecond)
		}
		threadMust(t, w.StopThread(agent.EndStopped))
		<-done
		clock.Suspend(2 * time.Second)
		threadMust(t, w.Poll(context.Background()))
		if threadState(t, w) != "stopped" {
			t.Fatalf("state=%s", threadState(t, w))
		}
		processes, err := threadProcesses()
		threadMust(t, err)
		for _, p := range processes {
			if p.group == adapter.cmd.Process.Pid && !p.zombie {
				t.Fatalf("live Agent process after stop: %d", p.pid)
			}
		}
		reports := threadReports(t, w)
		if reports[len(reports)-2].Kind != "turn.ended" || reports[len(reports)-1].Reason != "Agent 没有在 1 分钟内停下，已结束进程" {
			t.Fatal("missing forced stop report")
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestThreadProcessTreeTimeout$", "-test.timeout=8s")
	cmd.Env = append(os.Environ(), "SESSION_THREAD_PROCESS_HELPER=1")
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Worker process: %v\n%s", err, raw)
	}
}

func TestThreadUnixLiveOutputDoesNotPersist(t *testing.T) {
	a := &liveThreadFake{threadFake: &threadFake{resume: true}}
	w := newThreadTestWorker(t, nil, a.threadFake)
	w.adapter = a
	a.text = strings.Repeat("界", 100000)
	request := func(cursor string) protocol.SessionResult {
		return w.SessionRequest(context.Background(), newThreadOutputRequest(t, w, cursor))
	}
	first := request("")
	if !first.OK || !first.Gap || len(first.Text) > 16<<10 {
		t.Fatalf("output=%+v", first)
	}
	second := request(first.Cursor)
	if !second.OK || second.Cursor == first.Cursor {
		t.Fatal("cursor did not advance")
	}
	epoch, _, _ := strings.Cut(first.Cursor, ":")
	invalid := request(epoch + ":" + strconv.Itoa(int(w.live.liveBase)+1))
	if invalid.Code != "invalid_cursor" {
		t.Fatal("accepted cursor inside UTF-8 rune")
	}
	old := request("old:0")
	if !old.OK || !old.Gap {
		t.Fatal("missing restart gap")
	}
	if threadCount(t, w, `SELECT COUNT(*) FROM thread_replies`) != 0 {
		t.Fatal("persisted live output as reply")
	}
}
