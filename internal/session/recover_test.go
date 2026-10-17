package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

func TestRestartAfterStartIntentDoesNotResendInput(t *testing.T) {
	dir := t.TempDir()
	sessionID := mustSessionID(t)
	logPath := filepath.Join(dir, "executor.log")
	t.Setenv("BATON_TEST_EXECUTOR_LOG", logPath)
	if _, err := EnsureToken(dir, sessionID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = RunWorker(ctx, dir, sessionID) }()
	endpoint, err := Endpoint(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := readToken(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	client := waitClient(t, endpoint, token)
	taskID, execID := mustSessionID(t), mustSessionID(t)
	if _, err := client.Bind(taskID, execID, "pi"); err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	if _, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	client.Close()
	cancel()
	waitWorkerDown(t, endpoint, token)

	ctx, cancel = context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = runWorkerWhenFree(ctx, dir, sessionID) }()
	client = waitClient(t, endpoint, token)
	defer client.Close()
	st, err := client.Status()
	if err != nil || !st.Uncertain || !st.StartIntent || st.ExecutorInputs != 0 || st.ExecutorStarts != 0 {
		t.Fatalf("重启后的 Worker 仍像可以继续输入: %v %+v", err, st)
	}
	got, err := client.SubmitInput(`{"description":"不要重发"}`)
	if err != nil || got.ExecutorInputs != 0 || !got.Uncertain {
		t.Fatalf("不确定窗口又提交了输入: %v %+v", err, got)
	}
	var verified bool
	for _, rep := range got.Reports {
		if rep.Kind != protocol.ReportNeedsVerification {
			continue
		}
		var body struct {
			Status       string `json:"status"`
			ErrorMessage string `json:"error_message"`
		}
		if err := json.Unmarshal(rep.Body, &body); err != nil {
			t.Fatal(err)
		}
		verified = body.Status == task.StatusNeedsVerification && body.ErrorMessage == task.UncertainInputMessage
	}
	if !verified {
		t.Fatalf("没有留下待核实报告: %+v", got.Reports)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil || strings.Count(string(raw), "start\n") != 1 || strings.Count(string(raw), "input\n") != 0 {
		t.Fatalf("执行器日志不正确: %q %v", raw, err)
	}
}

func TestCorruptLedgerIsNotReplaced(t *testing.T) {
	dir := t.TempDir()
	sessionID := mustSessionID(t)
	path, err := LedgerPath(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not-a-sqlite-ledger"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureToken(dir, sessionID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err = RunWorker(ctx, dir, sessionID)
	if !errors.Is(err, ErrHistoryIncompatible) {
		t.Fatalf("损坏账本被当成可恢复: %v", err)
	}
	if err := InspectLedger(path); !errors.Is(err, ErrHistoryIncompatible) {
		t.Fatalf("损坏账本被换成了空历史: %v", err)
	}
}

func TestMissingLedgerIsNotCreated(t *testing.T) {
	dir := t.TempDir()
	sessionID := mustSessionID(t)
	path, err := LedgerPath(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := InspectLedger(path); !errors.Is(err, ErrHistoryMissing) {
		t.Fatalf("缺失账本的结论是 %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("检查缺失账本时创建了文件: %v", err)
	}
}

func waitWorkerDown(t *testing.T, endpoint, token string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		client, err := Dial(ctx, endpoint, token)
		cancel()
		if err != nil {
			return
		}
		client.Close()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("原来的 Worker 没有退出")
}

func runWorkerWhenFree(ctx context.Context, dir, sessionID string) error {
	deadline := time.Now().Add(5 * time.Second)
	var last error
	for {
		err := RunWorker(ctx, dir, sessionID)
		if ctx.Err() != nil {
			return nil
		}
		if !errors.Is(err, ErrSessionOwned) {
			return err
		}
		last = err
		if time.Now().After(deadline) {
			return last
		}
		time.Sleep(20 * time.Millisecond)
	}
}
