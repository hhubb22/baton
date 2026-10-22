package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/agent/replay"
	"baton/internal/protocol"
	"baton/internal/store"
)

// threadReplay 保留真实 Pi 的启动和首轮协议，后续轮次使用明确的文本回复。
func threadReplay(t *testing.T) replay.Transcript {
	t.Helper()
	tape := pireplaytest.Tape(t, "../agent/pi/testdata/replay", "simple")
	tape.Entries = tape.Entries[:len(tape.Entries)-1]
	for i := range tape.Entries {
		e := &tape.Entries[i]
		if e.Label == "event:message_end:5" {
			var frame map[string]any
			if err := json.Unmarshal(e.Frame, &frame); err != nil {
				t.Fatal(err)
			}
			frame["message"].(map[string]any)["content"] = []map[string]string{{"type": "text", "text": "thread replay reply"}}
			e.Frame, _ = json.Marshal(frame)
		}
	}
	frame := func(kind, label, raw string) {
		tape.Entries = append(tape.Entries, replay.Entry{Type: kind, Process: 2, Label: label, Frame: json.RawMessage(raw)})
	}
	frame("expect_outbound", "request:second", `{"id":"<$request_id_next>","type":"prompt","message":"second message"}`)
	frame("emit_inbound", "response:second", `{"type":"response","command":"prompt","id":"<$request_id_next>","success":true,"data":{"disposition":"started"}}`)
	frame("emit_inbound", "reply:second", `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second reply"}],"stopReason":"stop"}}`)
	frame("emit_inbound", "settled:second", `{"type":"agent_settled","aborted":false}`)
	tape.Entries = append(tape.Entries, replay.Entry{Type: "runtime_exit", Process: 2, Label: "process:thread-end"})
	return tape
}

func startThreadReplayStack(t *testing.T, tape replay.Transcript, gates ...string) (*processStack, *pireplaytest.Fixture, string) {
	t.Helper()
	dir := pireplaytest.Canonical(t, t.TempDir())
	work := pireplaytest.Canonical(t, t.TempDir())
	binary := buildFixture(t, "../../tools/agent-replay", "agent-replay")
	f := pireplaytest.New(t, binary, tape, filepath.Join(dir, "node"), newProcessID(t), work, gates...)
	coord, batond := buildProjectBins(t)
	st := startThreadStackWithBins(t, map[string]string{
		"BATON_HTTP_ADDR": freeAddr(t), "BATON_PI_BIN": f.Binary, "BATON_PI_MODEL": pireplaytest.Model,
	}, coord, batond, dir)
	t.Cleanup(func() {
		// Worker 与 batond 分开存活，先结束节点再清理 Worker。
		st.batond.stop()
		cleanupSessionWorkers(st.dataDir)
	})
	if out, err := exec.Command(st.batondBin, "files", "add", "--data-dir", st.dataDir, "--id", "thread-root", "--path", work).CombinedOutput(); err != nil {
		t.Fatalf("登记目录: %v %s", err, out)
	}
	if _, err := st.pool.Exec(context.Background(), `UPDATE employees SET must_change_password=false WHERE id=$1`, st.employeeID); err != nil {
		t.Fatal(err)
	}
	waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool {
		if len(r.Roots) != 1 {
			return false
		}
		for _, a := range r.Agents {
			if a.AgentType == "pi" && a.Status == "available" && a.Capabilities.Create {
				return true
			}
		}
		return false
	})
	return st, f, work
}

func createBrowserThread(t *testing.T, st *processStack, work, text string) store.Thread {
	t.Helper()
	var thread store.Thread
	if status := postJSON(t, st.client, st.base+"/api/v1/threads", map[string]any{
		"client_thread_id": newProcessID(t), "node_id": st.ident.NodeID, "agent_type": "pi", "working_directory": work,
		"message": map[string]string{"client_message_id": newProcessID(t), "content": text},
	}, st.csrf, &thread); status != http.StatusCreated || thread.ID == "" {
		t.Fatalf("新建 Thread: status=%d thread=%+v", status, thread)
	}
	return thread
}

func waitThreadTurn(t *testing.T, st *processStack, id string, seq int, ended bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var found bool
		err := st.pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=$1 AND worker_turn_seq=$2 AND (ended_at IS NOT NULL)=$3)`, id, seq, ended).Scan(&found)
		if err == nil && found {
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatalf("Thread %s Turn %d ended=%t 未报告；Coordinator=%s；batond=%s", id, seq, ended, st.coord.out.String(), st.batond.out.String())
}

func TestThreadRealProcessesReplyQueueAndReconnect(t *testing.T) {
	t.Parallel()
	st, f, work := startThreadReplayStack(t, threadReplay(t), "event:agent_settled", "settled:second", "process:thread-end")
	thread := createBrowserThread(t, st, work, "first message")
	f.Wait(t, "event:agent_settled")
	waitThreadTurn(t, st, thread.ID, 1, false)
	before := workerStatus(t, st.dataDir, thread.ID)
	messageID := newProcessID(t)
	payload := map[string]string{"client_message_id": messageID, "content": "second message", "mode": "queue"}
	for i := 0; i < 2; i++ {
		if status := postJSON(t, st.client, st.base+"/api/v1/threads/"+thread.ID+"/messages", payload, st.csrf, nil); status != http.StatusAccepted {
			t.Fatal(status)
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	var state string
	for time.Now().Before(deadline) {
		_ = st.pool.QueryRow(context.Background(), `SELECT status FROM thread_messages WHERE thread_id=$1 AND client_message_id=$2`, thread.ID, messageID).Scan(&state)
		if state == "queued" {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if state != "queued" {
		t.Fatalf("消息未进入 Worker 队列: %s", state)
	}
	st.batond.stop()
	if err := processAlive(before.PID); err != nil {
		t.Fatalf("batond 退出带走 Worker: %v", err)
	}
	restartCoord(t, st)
	restartBatond(t, st)
	after := workerStatus(t, st.dataDir, thread.ID)
	if before.PID != after.PID {
		t.Fatalf("重启未重连原 Worker: %d → %d", before.PID, after.PID)
	}
	f.Release(t, "event:agent_settled")
	f.Wait(t, "settled:second")
	waitThreadTurn(t, st, thread.ID, 1, true)
	waitThreadTurn(t, st, thread.ID, 2, false)
	f.Release(t, "settled:second")
	waitThreadTurn(t, st, thread.ID, 2, true)
	waitThreadStatus(t, st, thread.ID, "idle")
	var messages, turns, replies int
	if err := st.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM thread_messages WHERE thread_id=$1),(SELECT count(*) FROM thread_turns WHERE thread_id=$1),(SELECT count(*) FROM thread_replies WHERE thread_id=$1 AND content IN ('thread replay reply','second reply'))`, thread.ID).Scan(&messages, &turns, &replies); err != nil || messages != 2 || turns != 2 || replies != 2 {
		t.Fatalf("重连产生重复或缺失: messages=%d turns=%d replies=%d err=%v", messages, turns, replies, err)
	}
	var view store.Thread
	if err := getJSON(t, st.client, st.base+"/api/v1/threads/"+thread.ID, &view); err != nil || view.Status != "idle" {
		t.Fatal(view, err)
	}
	// 原生历史从设备读取，中心响应禁止缓存。
	resp, err := st.client.Get(st.base + "/api/v1/threads/" + thread.ID + "/history")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Thread 历史: status=%d cache=%s", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	var history protocol.SessionResult
	if err := json.NewDecoder(resp.Body).Decode(&history); err != nil || !history.OK || history.History == nil || len(history.History.Entries) == 0 {
		t.Fatalf("Thread 历史未从设备读回: %+v %v", history, err)
	}
	if strings.Contains(st.coord.out.String(), "thread replay reply") {
		t.Fatal("回复正文进入中心日志")
	}
}

func TestThreadRealProcessesWorkerCrashDoesNotResend(t *testing.T) {
	t.Parallel()
	st, f, work := startThreadReplayStack(t, pireplaytest.Tape(t, "../agent/pi/testdata/replay", "restore_load_only"), "event:agent_settled", "process:done:3")
	thread := createBrowserThread(t, st, work, "first message")
	f.Wait(t, "event:agent_settled")
	waitThreadTurn(t, st, thread.ID, 1, false)
	worker := workerStatus(t, st.dataDir, thread.ID)
	p, err := os.FindProcess(worker.PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = p.Release()
	waitThreadStatus(t, st, thread.ID, "unknown")
	waitThreadTurn(t, st, thread.ID, 1, true)
	var turns, sent int
	if err := st.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM thread_turns WHERE thread_id=$1),(SELECT count(*) FROM thread_messages WHERE thread_id=$1 AND status='sent')`, thread.ID).Scan(&turns, &sent); err != nil || turns != 1 || sent != 1 {
		t.Fatalf("崩溃后重复发送: turns=%d sent=%d %v", turns, sent, err)
	}
}
