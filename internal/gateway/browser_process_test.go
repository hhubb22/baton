package gateway_test

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
	"github.com/coder/websocket"
)

func TestBrowserSlowSubscriberDoesNotBlockNativeThread(t *testing.T) {
	t.Parallel()
	tape := threadReplay(t)
	for i, e := range tape.Entries {
		if e.Label == "request:second" {
			tape.Entries = append(tape.Entries[:i], tape.Entries[len(tape.Entries)-1])
			break
		}
	}
	for i := range tape.Entries {
		e := &tape.Entries[i]
		if e.Label == "event:message_update:8" {
			var frame map[string]any
			if err := json.Unmarshal(e.Frame, &frame); err != nil {
				t.Fatal(err)
			}
			frame["assistantMessageEvent"].(map[string]any)["delta"] = strings.Repeat("输出", 1024*1024)
			e.Frame, _ = json.Marshal(frame)
		}
	}
	st, f, work := startThreadReplayStack(t, tape, "event:message_update:8", "process:thread-end")
	if _, err := st.pool.Exec(context.Background(), `UPDATE employees SET must_change_password=false WHERE id=$1`, st.employeeID); err != nil {
		t.Fatal(err)
	}
	thread := createBrowserThread(t, st, work, "output pressure")
	f.Wait(t, "event:message_update:8")
	before := workerStatus(t, st.dataDir, thread.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: st.roots, MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if tcp, ok := c.(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(1024)
		}
		return c, err
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Jar: st.client.Jar}
	ws, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(st.base, "https")+"/api/v1/events", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {st.base}}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	raw, _ := json.Marshal(map[string]string{"thread_id": thread.ID})
	if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			t.Fatal("Thread 实时订阅未建立", err)
		}
		var event struct {
			Type     string `json:"type"`
			ThreadID string `json:"thread_id"`
			OK       bool   `json:"ok"`
		}
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "thread.output" {
			if event.ThreadID != thread.ID || !event.OK {
				t.Fatalf("Thread 实时输出没有到达订阅者: %s", raw)
			}
			break
		}
	}
	// 订阅者停止消费输出，Worker 仍须读取协议并持久化回复和 Turn 结束。
	f.Release(t, "event:message_update:8")
	waitThreadTurn(t, st, thread.ID, 1, true)
	waitThreadStatus(t, st, thread.ID, "idle")
	after := workerStatus(t, st.dataDir, thread.ID)
	if after.PID != before.PID {
		t.Fatal("输出订阅导致 Worker 被替换")
	}
	host := &session.Host{DataDir: st.dataDir}
	result, err := host.BrowserRequest(ctx, protocol.SessionRequest{SessionID: thread.ID, OperationID: newProcessID(t), Action: "output"})
	if err != nil || !result.OK || !result.Gap || len(result.Text) > protocol.SessionOutputBytes {
		t.Fatalf("慢订阅缺口或输出上限无效: %v ok=%v gap=%v bytes=%d", err, result.OK, result.Gap, len(result.Text))
	}
	var outputs, replies int
	if err := st.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM thread_events WHERE thread_id=$1 AND row_to_json(thread_events)::text LIKE '%输出输出输出输出%'),(SELECT count(*) FROM thread_replies WHERE thread_id=$1 AND content='thread replay reply')`, thread.ID).Scan(&outputs, &replies); err != nil || outputs != 0 || replies != 1 {
		t.Fatalf("实时输出或回复持久化错误: outputs=%d replies=%d %v", outputs, replies, err)
	}
}
