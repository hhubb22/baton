package gateway_test

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/agent/replay"
	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"
	"github.com/coder/websocket"
)

func TestBrowserSlowSubscriberDoesNotBlockNativeWorker(t *testing.T) {
	t.Parallel()
	dir := pireplaytest.Canonical(t, t.TempDir())
	fixture := pireplaytest.Build(t, "../../tools/agent-replay")
	tape := pireplaytest.Tape(t, "../agent/pi/testdata/replay", "simple")
	// 单帧大输出用于验证缓冲上限和慢订阅者隔离；保留录制的帧顺序与最终结果。
	for _, e := range tape.Entries {
		if e.Label == "event:message_update:8" {
			var frame map[string]any
			if err := json.Unmarshal(e.Frame, &frame); err != nil {
				t.Fatal(err)
			}
			frame["assistantMessageEvent"].(map[string]any)["delta"] = strings.Repeat("输出", 1024*1024)
			raw, _ := json.Marshal(frame)
			var err error
			tape, err = tape.Replace(e.Label, raw)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	tapePath := filepath.Join(dir, "stress.ndjson")
	f, err := os.Create(tapePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := replay.Write(f, tape); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(dir, "replay-state")
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{"BATON_HTTP_ADDR": freeAddr(t), "BATON_TEST_HOLD_START": "0", "BATON_TEST_START_GATE": gate, "BATON_AGENT_DRIVER": "native", "BATON_PI_BIN": fixture, "BATON_PI_MODEL": pireplaytest.Model})
	t.Cleanup(func() {
		if raw, err := os.ReadFile(filepath.Join(stateDir, "failure.json")); err == nil {
			t.Errorf("转录失配: %s", raw)
		}
	})

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
	data := pireplaytest.Canonical(t, st.dataDir)
	work := pireplaytest.Canonical(t, filepath.Join(data, "sessions", sid, "workspace"))
	config := replay.Config{Transcript: tapePath, StateDir: stateDir, Bindings: map[string]string{"<fixture>": dir, "<home>": dir, "<node_data>": data, "<node_data_alias>": data, "<workspace>": work}}
	rawConfig, _ := json.Marshal(config)
	if err := os.WriteFile(fixture+".replay.json", rawConfig, 0600); err != nil {
		t.Fatal(err)
	}

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
