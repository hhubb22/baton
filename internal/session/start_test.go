package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
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

	"github.com/golang-jwt/jwt/v5"
)

func TestWorkerStartsOnceAfterValidPermit(t *testing.T) {
	t.Setenv("BATON_TEST_WALL_OFFSET", "24h")
	client, pub, priv, taskID, execID, _ := startBoundWorker(t)
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
	client, pub, priv, taskID, execID, _ := startBoundWorker(t)
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

func TestWorkerSubmitsInputOnceAndDoesNotTreatTextAsSuccess(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "text")
	client, pub, priv, taskID, execID, dir := startBoundWorker(t)
	defer client.Close()
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	if _, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	first, err := client.SubmitInput(`{"description":"调查天线"}`)
	if err != nil || first.ExecutorInputs != 1 || first.ExecutorStarts != 1 || first.ResultDelivered {
		t.Fatalf("第一次输入不正确: %v %+v", err, first)
	}
	again, err := client.SubmitInput(`{"description":"再来一次"}`)
	if err != nil || again.ExecutorInputs != 1 || again.ResultDelivered {
		t.Fatalf("重复输入又执行了一次: %v %+v", err, again)
	}
	var failed bool
	for _, rep := range first.Reports {
		var body struct {
			Status    string `json:"status"`
			Summary   string `json:"summary"`
			ErrorCode string `json:"error_code"`
			TaskID    string `json:"task_id"`
		}
		if err := json.Unmarshal(rep.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.TaskID != taskID {
			t.Fatalf("报告里的任务标识不是平台填写的: %s", body.TaskID)
		}
		if rep.Kind == "result" {
			failed = body.Status == "failed" && body.ErrorCode == "result_format" && !strings.Contains(body.Summary, "完成")
		}
	}
	if !failed {
		t.Fatalf("自由文本被当成了成功: %+v", first.Reports)
	}
	path, err := LedgerPath(dir, first.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var local int
	if err := db.QueryRow(`SELECT COUNT(*) FROM execution_log WHERE body LIKE '%' || ? || '%'`, "完成").Scan(&local); err != nil || local == 0 {
		t.Fatalf("本地没有留下自由文本: %v %d", err, local)
	}
}

func TestWorkerExitIsNotSuccess(t *testing.T) {
	t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", "exit")
	client, pub, priv, taskID, execID, _ := startBoundWorker(t)
	defer client.Close()
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	if _, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	st, err := client.SubmitInput(`{"description":"调查天线"}`)
	if err != nil || st.ExecutorInputs != 1 || st.ResultDelivered {
		t.Fatalf("退出后的输入状态不正确: %v %+v", err, st)
	}
	for _, rep := range st.Reports {
		if rep.Kind != "result" {
			continue
		}
		var body struct {
			Status    string `json:"status"`
			ErrorCode string `json:"error_code"`
		}
		if err := json.Unmarshal(rep.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "failed" || body.ErrorCode != "result_format" {
			t.Fatalf("进程退出被当成成功: %+v", body)
		}
	}
}

func TestWorkerOversizedInputFailsWithoutSecondSubmit(t *testing.T) {
	client, pub, priv, taskID, execID, _ := startBoundWorker(t)
	defer client.Close()
	nonce := armNonce(t, client, taskID, execID)
	generation := mustSessionID(t)
	queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
	permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
	if _, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	huge := strings.Repeat("x", protocol.MaxMessageBytes+1)
	first, err := client.SubmitInput(huge)
	if err != nil || first.ExecutorInputs != 0 || first.ExecutorStarts != 1 || first.ResultDelivered {
		t.Fatalf("超限输入不该交给执行器: %v %+v", err, first)
	}
	var failed bool
	for _, rep := range first.Reports {
		if rep.Kind != "result" {
			continue
		}
		var body struct {
			Status    string `json:"status"`
			ErrorCode string `json:"error_code"`
		}
		if err := json.Unmarshal(rep.Body, &body); err != nil {
			t.Fatal(err)
		}
		failed = body.Status == "failed" && body.ErrorCode == "execution_failed"
	}
	if !failed {
		t.Fatalf("超限输入没有回报失败: %+v", first.Reports)
	}
	again, err := client.SubmitInput(huge)
	if err != nil || again.ExecutorInputs != 0 {
		t.Fatalf("超限输入被再次提交: %v %+v", err, again)
	}
}

func TestWorkerSuspendConsumesBudget(t *testing.T) {
	t.Setenv("BATON_TEST_SUSPEND_AFTER_ARM", "6s")
	client, pub, priv, taskID, execID, dir := startBoundWorker(t)
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
	path, err := LedgerPath(dir, st.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	needs, err := LedgerNeedsWorker(path)
	if err != nil || needs {
		t.Fatalf("排队超时后的 Session 仍会拉起 Worker: %v %v", needs, err)
	}
}

func startBoundWorker(t *testing.T) (*Client, ed25519.PublicKey, ed25519.PrivateKey, string, string, string) {
	t.Helper()
	dir := t.TempDir()
	sessionID := mustSessionID(t)
	logPath := filepath.Join(dir, "executor.log")
	t.Setenv("BATON_TEST_EXECUTOR_LOG", logPath)
	if _, err := EnsureToken(dir, sessionID); err != nil {
		t.Fatal(err)
	}
	ledgerPath, err := LedgerPath(dir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := CreateLedger(ledgerPath); err != nil {
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
			for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
				if line != "" && line != "start" && line != "input" && line != "abort" {
					t.Errorf("执行器日志是 %q", raw)
				}
			}
		}
	})
	return client, pub, priv, taskID, execID, dir
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
