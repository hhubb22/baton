package gateway_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/session"

	"github.com/gofrs/flock"
)

func TestSessionCleanupDelayedWorkerHelper(t *testing.T) {
	dataDir := os.Getenv("BATON_TEST_CLEANUP_WORKER_DIR")
	if dataDir == "" {
		return
	}
	sessionID := os.Getenv("BATON_TEST_CLEANUP_WORKER_SESSION")
	control := bufio.NewReader(os.Stdin)
	fmt.Println("worker_started")
	if _, err := control.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	lockPath, err := session.LockPath(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	lock := flock.New(lockPath)
	owned, err := lock.TryLock()
	if err != nil || !owned {
		t.Fatalf("取得 Worker 锁: owned=%t err=%v", owned, err)
	}
	defer lock.Close()
	tokenPath, err := session.TokenPath(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("worker_initializing")
	if _, err := control.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	endpoint, err := session.Endpoint(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := session.ListenLocal(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	for {
		conn, err := ln.Accept()
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		dec, enc := json.NewDecoder(conn), json.NewEncoder(conn)
		var auth struct{ Type, Token string }
		if err := dec.Decode(&auth); err != nil || auth.Type != "auth" || auth.Token != strings.TrimSpace(string(token)) {
			_ = conn.Close()
			continue
		}
		_ = enc.Encode(map[string]any{"type": "result", "ok": true})
		var request struct{ Type string }
		if err := dec.Decode(&request); err == nil && request.Type == "status" {
			_ = enc.Encode(map[string]any{"type": "result", "ok": true, "pid": os.Getpid(), "session_id": sessionID})
		}
		_ = conn.Close()
	}
}

func TestCleanupSessionWorkersWaitsForInitializingWorker(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "node with spaces")
	sessionID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	token, err := session.EnsureToken(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	// 没有持锁进程的旧会话应直接完成清理。
	deadSession, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	deadToken, err := session.EnsureToken(dataDir, deadSession)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	err = cleanupSessionWorker(ctx, dataDir, deadSession, deadToken)
	cancel()
	if err != nil {
		t.Fatalf("已退出的 Worker 未直接结束清理: %v", err)
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestSessionCleanupDelayedWorkerHelper$", "-test.timeout=10s", "worker", "--data-dir", dataDir, "--session", sessionID)
	cmd.Env = append(os.Environ(), "BATON_TEST_CLEANUP_WORKER_DIR="+dataDir, "BATON_TEST_CLEANUP_WORKER_SESSION="+sessionID)
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		_ = input.Close()
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = input.Close()
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			t.Error("兜底终止 Worker 后仍未退出")
		}
		endpoint, _ := session.Endpoint(dataDir, sessionID)
		_ = os.Remove(endpoint)
	})
	ready := make(chan string, 2)
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			ready <- scanner.Text()
		}
		close(ready)
	}()
	waitReady := func(want string) {
		t.Helper()
		select {
		case line := <-ready:
			if line != want {
				t.Fatalf("Worker 状态: got=%q want=%q", line, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("Worker 未到达 %s", want)
		}
	}
	waitReady("worker_started")
	cancelled, cancelStop := context.WithCancel(context.Background())
	cancelStop()
	if err := stopWorkerContext(cancelled, cmd.Process.Pid); !errors.Is(err, context.Canceled) {
		t.Fatalf("终止操作未遵守调用方取消: %v", err)
	}
	if err := processAlive(cmd.Process.Pid); err != nil {
		t.Fatalf("已取消的终止操作仍杀掉了 Worker: %v", err)
	}
	if err := cleanupSessionWorker(cancelled, dataDir, sessionID, token); !errors.Is(err, context.Canceled) {
		t.Fatalf("清理未遵守调用方取消: %v", err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	starting, err := sessionWorkerStarting(ctx, dataDir, sessionID)
	cancel()
	if err != nil || !starting {
		t.Fatalf("无法识别本测试取锁前的 Worker: found=%t err=%v", starting, err)
	}
	// 相同目录的其他 Session，以及相同 Session 的其他目录，都不属于这个 Worker。
	otherDir := dataDir + "-other"
	otherToken, err := session.EnsureToken(otherDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct{ dir, id, token string }{
		{dataDir, deadSession, deadToken},
		{otherDir, sessionID, otherToken},
	} {
		ctx, cancel = context.WithTimeout(context.Background(), 500*time.Millisecond)
		err = cleanupSessionWorker(ctx, target.dir, target.id, target.token)
		cancel()
		if err != nil {
			t.Fatalf("清理误匹配了其他目录或 Session 的 Worker: %v", err)
		}
	}
	lockPath, _ := session.LockPath(dataDir, sessionID)
	beforeLock := flock.New(lockPath)
	free, err := beforeLock.TryLock()
	if err != nil || !free {
		t.Fatalf("取锁前的暂停点未生效: free=%t err=%v", free, err)
	}
	_ = beforeLock.Close()
	ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
	err = cleanupSessionWorker(ctx, dataDir, sessionID, token)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("已启动但尚未取锁的 Worker 被漏掉: %v", err)
	}
	if _, err := fmt.Fprintln(input, "lock"); err != nil {
		t.Fatal(err)
	}
	waitReady("worker_initializing")

	ctx, cancel = context.WithTimeout(context.Background(), 80*time.Millisecond)
	err = cleanupSessionWorker(ctx, dataDir, sessionID, token)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("持锁但未监听的 Worker 应明确报告超时: %v", err)
	}
	cleaned := make(chan error, 1)
	go func() { cleaned <- cleanupSessionWorkers(dataDir) }()
	if _, err := fmt.Fprintln(input, "listen"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-cleaned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("认证 IPC 就绪后未完成清理")
	}
	select {
	case <-exited:
	default:
		t.Fatal("清理返回时 Worker 仍未退出")
	}
	lock := flock.New(lockPath)
	defer lock.Close()
	free, err = lock.TryLock()
	if err != nil || !free {
		t.Fatalf("清理返回时会话锁仍未释放: free=%t err=%v", free, err)
	}
}
