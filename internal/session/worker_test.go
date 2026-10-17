package session

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"baton/internal/identity"
)

func TestWorkerBindDoesNotStartExecutor(t *testing.T) {
	dir := t.TempDir()
	sessionID := mustSessionID(t)
	logPath := filepath.Join(dir, "executor.log")
	t.Setenv("BATON_TEST_EXECUTOR_LOG", logPath)
	t.Setenv("BATON_TEST_SLOW_WRITE", "1")
	if _, err := EnsureToken(dir, sessionID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- RunWorker(ctx, dir, sessionID) }()
	endpoint, err := Endpoint(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := readToken(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	client := waitClient(t, endpoint, token)
	defer client.Close()
	taskID, execID := mustSessionID(t), mustSessionID(t)
	st, err := client.Bind(taskID, execID, "pi")
	if err != nil {
		t.Fatal(err)
	}
	if st.ExecutorStarts != 0 || st.HookRuns != 0 || st.PID == 0 {
		t.Fatalf("绑定启动了执行器: %+v", st)
	}
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatal("准备阶段写出了执行器日志")
	}
	again, err := client.Bind(taskID, execID, "pi")
	if err != nil || again.ExecutorStarts != 0 || again.HookRuns != 0 {
		t.Fatalf("重复绑定不正确: %v %+v", err, again)
	}
	other := mustSessionID(t)
	if _, err := client.Bind(taskID, other, "pi"); err != ErrSessionBusy {
		t.Fatalf("另一份执行得到 %v", err)
	}

	observer := NewObserver(logPath)
	if err := observer.Start(context.Background()); err != nil || observer.Starts() != 1 {
		t.Fatal("观察器没有记录启动")
	}
	if err := observer.RunStartupHooks(context.Background()); err != nil || observer.Hooks() != 1 {
		t.Fatal("观察器没有记录启动钩子")
	}
	raw, err := os.ReadFile(logPath)
	if err != nil || string(raw) != "start\nhook\n" {
		t.Fatalf("观察器日志是 %q err %v", raw, err)
	}
	st, err = client.Status()
	if err != nil || st.ExecutorStarts != 0 || st.HookRuns != 0 {
		t.Fatalf("Worker 执行器计数变了: %v %+v", err, st)
	}

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer dialCancel()
	left, err := Dial(dialCtx, endpoint, token)
	if err != nil {
		t.Fatal(err)
	}
	defer left.Close()
	right, err := Dial(dialCtx, endpoint, token)
	if err != nil {
		t.Fatal(err)
	}
	defer right.Close()
	var wg sync.WaitGroup
	seqs := make([]int64, 2)
	errs := make([]error, 2)
	clients := []*Client{left, right}
	started := time.Now()
	wg.Add(2)
	for i := range clients {
		go func(i int) {
			defer wg.Done()
			seqs[i], _, errs[i] = clients[i].Append("slow")
		}(i)
	}
	wg.Wait()
	if time.Since(started) < 350*time.Millisecond {
		t.Fatal("同一 Session 的写入没有互相等待")
	}
	seen := map[int64]bool{}
	for i, err := range errs {
		if err != nil || seqs[i] == 0 {
			t.Fatalf("写入失败: %v seq %d", err, seqs[i])
		}
		seen[seqs[i]] = true
	}
	if len(seen) != 2 {
		t.Fatalf("两次写入序号相同: %v", seqs)
	}
	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Worker 没有随上下文结束")
	}
}

func waitClient(t *testing.T, endpoint, token string) *Client {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		client, err := Dial(ctx, endpoint, token)
		cancel()
		if err == nil {
			return client
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(last)
	return nil
}

func mustSessionID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
