package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/startpermit"

	"github.com/golang-jwt/jwt/v5"
)

func TestWorkerStartsOnceAfterValidPermit(t *testing.T) {
	t.Setenv("BATON_TEST_WALL_OFFSET", "24h")
	client, pub, priv, taskID, execID := startBoundWorker(t)
	defer client.Close()
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	st, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano))
	if err != nil || !st.Started || st.ExecutorStarts != 1 || st.HookRuns != 0 {
		t.Fatalf("有效许可没有进入启动: %v %+v", err, st)
	}
	again, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano))
	if err != nil || !again.Started || again.ExecutorStarts != 1 || again.HookRuns != 0 {
		t.Fatalf("重复许可再次启动了执行器: %v %+v", err, again)
	}
	cancelled, err := client.CancelLocal()
	if err != nil || !cancelled.StartIntent || cancelled.ExecutorStarts != 1 {
		t.Fatalf("已启动后的取消抹掉了事实: %v %+v", err, cancelled)
	}
}

func TestWorkerRejectsBadPermitsBeforeStart(t *testing.T) {
	client, pub, priv, taskID, execID := startBoundWorker(t)
	defer client.Close()
	key := base64.RawURLEncoding.EncodeToString(pub)
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	queueText := queue.Format(time.RFC3339Nano)

	nodeTok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"iss": startpermit.Issuer, "sub": mustSessionID(t), "aud": []string{startpermit.NodeAudience},
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "jti": nonce,
	})
	signedNode, err := nodeTok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	assertRefused(t, client, taskID, execID, signedNode, key, generation, queueText)
	assertRefused(t, client, taskID, execID, signPermit(t, priv, taskID, mustSessionID(t), generation, nonce, queue, startpermit.PermitTTL), key, generation, queueText)
	assertRefused(t, client, taskID, execID, signPermit(t, priv, taskID, execID, mustSessionID(t), nonce, queue, startpermit.PermitTTL), key, generation, queueText)

	st, err := client.Status()
	if err != nil || st.ExecutorStarts != 0 || st.HookRuns != 0 || st.StartIntent {
		t.Fatalf("坏许可启动了执行器: %v %+v", err, st)
	}
	local, err := client.CancelLocal()
	if err != nil || local.StartIntent || local.ExecutorStarts != 0 {
		t.Fatalf("取消前的状态不正确: %v %+v", err, local)
	}
	valid := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	_, err = client.Authorize(taskID, execID, valid, key, generation, queueText)
	var refused *StartError
	if !errors.As(err, &refused) {
		t.Fatalf("本地取消之后仍然启动: %v", err)
	}
	st, err = client.Status()
	if err != nil || st.ExecutorStarts != 0 || st.StartIntent {
		t.Fatalf("取消后的执行器计数变了: %v %+v", err, st)
	}
}

func TestWorkerSuspendConsumesBudget(t *testing.T) {
	t.Setenv("BATON_TEST_SUSPEND_AFTER_ARM", "6s")
	client, pub, priv, taskID, execID := startBoundWorker(t)
	defer client.Close()
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	_, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano))
	var refused *StartError
	if !errors.As(err, &refused) || refused.Code != "queue_timeout" {
		t.Fatalf("暂停唤醒后的许可被接受: %v", err)
	}
	st, err := client.Status()
	if err != nil || st.ExecutorStarts != 0 || st.StartIntent {
		t.Fatalf("没有预算仍然启动: %v %+v", err, st)
	}
}

func startBoundWorker(t *testing.T) (*Client, ed25519.PublicKey, ed25519.PrivateKey, string, string) {
	t.Helper()
	dir := t.TempDir()
	sessionID := mustSessionID(t)
	logPath := filepath.Join(dir, "executor.log")
	t.Setenv("BATON_TEST_EXECUTOR_LOG", logPath)
	if _, err := EnsureToken(dir, sessionID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
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
	t.Cleanup(func() {
		if _, err := os.Stat(logPath); err == nil {
			raw, _ := os.ReadFile(logPath)
			if string(raw) != "" && string(raw) != "start\n" {
				t.Errorf("执行器日志是 %q", raw)
			}
		}
	})
	return client, pub, priv, taskID, execID
}

func armNonce(t *testing.T, client *Client, taskID, execID string) string {
	t.Helper()
	st, err := client.Arm(taskID, execID)
	if err != nil || st.Nonce == "" || st.ExecutorStarts != 0 {
		t.Fatalf("武装许可失败: %v %+v", err, st)
	}
	return st.Nonce
}

func signPermit(t *testing.T, key ed25519.PrivateKey, taskID, execID, generation, nonce string, queue time.Time, life time.Duration) string {
	t.Helper()
	issued := time.Now().UTC().Truncate(time.Millisecond)
	token, err := startpermit.Sign(key, startpermit.Claims{
		NodeID: mustSessionID(t), EmployeeID: mustSessionID(t), TaskID: taskID, ExecutionID: execID,
		StorageGeneration: generation, Nonce: nonce, RequestHash: bytes32(3),
		QueueExpiresAt: queue, IssuedAt: issued, ExpiresAt: issued.Add(life),
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func assertRefused(t *testing.T, client *Client, taskID, execID, permit, key, generation, queue string) {
	t.Helper()
	_, err := client.Authorize(taskID, execID, permit, key, generation, queue)
	var refused *StartError
	if !errors.As(err, &refused) || !refused.Refused {
		t.Fatalf("坏许可没有被拒绝: %v", err)
	}
}

func bytes32(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}
