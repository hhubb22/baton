package gateway_test

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"
	"github.com/coder/websocket"
)

func TestBrowserSlowSubscriberDoesNotBlockNativeWorker(t *testing.T) {
	dir := t.TempDir()
	fixture := filepath.Join(dir, "pi-replay")
	if runtime.GOOS == "windows" {
		fixture += ".exe"
	}
	build := exec.Command("go", "test", "-c", "-o", fixture, "./internal/agent/pi")
	build.Dir = filepath.Join("..", "..")
	if raw, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建 Pi 协议执行器: %v %s", err, raw)
	}
	tape := filepath.Join(dir, "events.jsonl")
	f, err := os.Create(tape)
	if err != nil {
		t.Fatal(err)
	}
	enc := json.NewEncoder(f)
	for i := 0; i < 2048; i++ {
		_ = enc.Encode(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]string{"type": "text_delta", "delta": strings.Repeat("输出", 512)}})
	}
	final := `{"status":"completed","summary":"输出已完成","evidence":[],"evidence_empty_reason":"协议压力测试","artifacts":[],"artifacts_empty_reason":"无产物","error":null}`
	_ = enc.Encode(map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []map[string]string{{"type": "text", "text": final}}, "stopReason": "stop"}})
	_ = enc.Encode(map[string]any{"type": "agent_settled", "aborted": false})
	_ = f.Close()
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_START_GATE": gate, "BATON_AGENT_DRIVER": "native", "BATON_PI_BIN": fixture, "BATON_PI_REPLAY_CHILD": "1", "BATON_PI_REPLAY_FIXTURE": tape})
	if _, err := st.pool.Exec(context.Background(), `UPDATE employees SET must_change_password=false WHERE id=$1`, st.employeeID); err != nil {
		t.Fatal(err)
	}
	var created task.Record
	if status := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{"request_id": "slow-browser", "description": "输出压力测试"}, st.csrf, &created); status != http.StatusOK {
		t.Fatal(status)
	}
	execution := waitGateFile(t, gate)
	deadline := time.Now().Add(10 * time.Second)
	var sid string
	for time.Now().Before(deadline) {
		_ = st.pool.QueryRow(context.Background(), `SELECT target_session_id::text FROM tasks WHERE id=$1`, created.TaskID).Scan(&sid)
		if sid != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sid == "" {
		t.Fatal("没有保存准备事实")
	}
	before := workerStatus(t, st.dataDir, sid)
	defer stopWorker(before.PID)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: st.roots, MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if tcp, ok := c.(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(1024)
		}
		return c, err
	}}
	client := &http.Client{Transport: transport, Jar: st.client.Jar}
	ws, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(st.base, "https")+"/api/v1/events", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {st.base}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	raw, _ := json.Marshal(map[string]string{"session_id": sid})
	if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	// 订阅者不消费输出，Agent 仍须读取全部协议帧并持久化完成结果。
	releaseGate(t, gate, execution)
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	after := workerStatus(t, st.dataDir, sid)
	if after.PID != before.PID {
		t.Fatal("输出订阅导致 Worker 被替换")
	}
	op, _ := identity.NewUUID()
	host := &session.Host{DataDir: st.dataDir}
	result, err := host.BrowserRequest(ctx, protocol.SessionRequest{SessionID: sid, OperationID: op, Action: "output"})
	if err != nil || !result.OK || !result.Gap || len(result.Text) > protocol.SessionOutputBytes {
		t.Fatalf("慢订阅缺口或输出上限无效: %v ok=%v gap=%v bytes=%d", err, result.OK, result.Gap, len(result.Text))
	}
	// 源输出 6 MiB，只取有限的节点缓存；完整原文不进入中心持久化表。
	var count int
	if err := st.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_events WHERE task_id=$1 AND row_to_json(task_events)::text LIKE '%输出输出输出输出%'`, created.TaskID).Scan(&count); err != nil || count != 0 {
		t.Fatal("中心保存了原生输出")
	}
}
