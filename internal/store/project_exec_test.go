package store_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

func execArgs(h *toolHarness, wait int) map[string]any {
	return map[string]any{"node_id": h.src.NodeID, "command": "printf test", "working_directory": "/registered", "wait_seconds": wait}
}
func enableExec(t *testing.T, h *toolHarness) {
	t.Helper()
	if _, err := h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(jsonb_set(report,'{exec,enabled}','true'),'{roots}','[{"root_id":"dev","path":"/registered"}]') WHERE node_id=$1`, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
}
func pendingThread(t *testing.T, out any) string {
	t.Helper()
	return decodeWaitPending(t, out).ThreadID
}

func projectReport(t *testing.T, h *toolHarness, id, kind string, change func(*protocol.ThreadReport)) {
	t.Helper()
	var seq int64
	if err := h.pool.QueryRow(h.ctx, `SELECT last_worker_seq+1 FROM threads WHERE id=$1`, id).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: mustUUID(t), WorkerSeq: seq, Kind: kind}
	if change != nil {
		change(&r)
	}
	if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err != nil || !ack.OK {
		t.Fatal(kind, ack, err)
	}
}
func startProjectShell(t *testing.T, h *toolHarness, id string) {
	projectReport(t, h, id, "thread.opened", func(r *protocol.ThreadReport) {
		r.StorageGeneration = "generation"
		r.NativeSessionID = "shell-session"
	})
	var key string
	if err := h.pool.QueryRow(h.ctx, `SELECT client_message_id FROM thread_messages WHERE thread_id=$1`, id).Scan(&key); err != nil {
		t.Fatal(err)
	}
	projectReport(t, h, id, "turn.started", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.ClientMessageID = key })
	projectReport(t, h, id, "message.sent", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.ClientMessageID = key })
}
func finishProjectShell(t *testing.T, h *toolHarness, id, output string, metadata json.RawMessage) {
	projectReport(t, h, id, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Content = output; r.Metadata = metadata })
	projectReport(t, h, id, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Reason = "completed"; r.QueueEmpty = true })
}

func TestProjectExecParametersAndIdempotentRecovery(t *testing.T) {
	h := newToolHarness(t)
	if _, bad := h.call(t, "nodes.exec", execArgs(h, 30)); !bad {
		t.Fatal("未开启仍接受命令")
	}
	enableExec(t, h)
	for _, wait := range []int{-1, 601} {
		if _, bad := h.call(t, "nodes.exec", execArgs(h, wait)); !bad {
			t.Fatal("接受无效等待时间")
		}
	}
	req := h.save(t, "nodes.exec", execArgs(h, 600))
	h.repo.SetCommitHook(func(context.Context) error { return errors.New("injected") })
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err == nil {
		t.Fatal("注入失败未生效")
	}
	h.repo.SetCommitHook(nil)
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 0 {
		t.Fatal(n)
	}
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	id := pendingThread(t, out)
	var key, origin, sender, call, agent string
	var timeout, messages int
	if err = h.pool.QueryRow(h.ctx, `SELECT t.client_thread_id,t.origin_conversation_id::text,m.sender,m.origin_tool_call_id,t.agent_type,t.execution_timeout_seconds,(SELECT count(*) FROM thread_messages WHERE thread_id=t.id) FROM threads t JOIN thread_messages m ON m.thread_id=t.id WHERE t.id=$1`, id).Scan(&key, &origin, &sender, &call, &agent, &timeout, &messages); err != nil {
		t.Fatal(err)
	}
	if key != "pa:"+h.project.Conversation.ID+":"+req.ToolCallID || origin != h.project.Conversation.ID || sender != "project_agent" || call != req.ToolCallID || agent != "shell" || timeout != 7200 || messages != 1 {
		t.Fatal(key, origin, sender, call, agent, timeout, messages)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(report,'{exec,enabled}','false') WHERE node_id=$1`, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	if out, err = h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil || pendingThread(t, out) != id {
		t.Fatal(err)
	}
	wait := req
	wait.Operation = "wait_tool"
	if out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait); err != nil || pendingThread(t, out) != id {
		t.Fatal(err)
	}
	wait.Payload = json.RawMessage(`{"finish_wait":true}`)
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil {
		t.Fatal(err)
	}
	e := out.(projectagent.Event)
	text, bad := toolText(t, e)
	if bad || !strings.Contains(string(text), "仍在执行") || !strings.Contains(string(text), id) {
		t.Fatal(string(text))
	}
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, wait); err != nil {
		t.Fatal(err)
	}
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, id, store.ThreadMessageInput{ClientMessageID: "second", Content: "again"}); err == nil {
		t.Fatal("shell 接受第二条消息")
	}
}

func TestProjectExecCompletionOutputAndNoDuplicateInputs(t *testing.T) {
	for _, binary := range []bool{false, true} {
		t.Run(fmt.Sprint(binary), func(t *testing.T) {
			h, req, p := execWaitFixture(t, 600)
			startProjectShell(t, h, p.ThreadID)
			output := strings.Repeat("a\"\\\x01", 8192)
			metadata := json.RawMessage(`{"exit_code":7}`)
			if binary {
				output = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0, 1, 0xff}, 8192))
				metadata = json.RawMessage(`{"exit_code":7,"encoding":"base64"}`)
			}
			finishProjectShell(t, h, p.ThreadID, output, metadata)
			var payload []byte
			var size int
			if err := h.pool.QueryRow(h.ctx, `SELECT payload,octet_length(payload::text) FROM project_agent_input_queue WHERE source_key=$1`, "thread:"+p.ThreadID+":turn:1").Scan(&payload, &size); err != nil || size > 72<<10 || !strings.Contains(string(payload), "command_result") {
				t.Fatal(size, err)
			}
			wait := req
			wait.Operation = "wait_tool"
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, wait)
			if err != nil {
				t.Fatal(err)
			}
			e := out.(projectagent.Event)
			raw, bad := toolText(t, e)
			var result struct {
				ThreadID string `json:"thread_id"`
				Status   string `json:"status"`
				Command  struct {
					ExitCode int    `json:"exit_code"`
					Output   string `json:"output"`
				} `json:"command_result"`
			}
			if err = json.Unmarshal(raw, &result); err != nil || bad || result.ThreadID != p.ThreadID || result.Status != "stopped" || result.Command.ExitCode != 7 || result.Command.Output == "" {
				t.Fatal(string(raw), err)
			}
			if binary {
				if _, err = base64.StdEncoding.Strict().DecodeString(result.Command.Output); err != nil {
					t.Fatal("base64 被截断破坏", err)
				}
			}
			if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type IN ('thread_reply','turn_ended') AND delivered_seq IS NULL`); n != 0 {
				t.Fatal(n)
			}
			if replay, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil || replay.(projectagent.Event).Seq != e.Seq {
				t.Fatal(err)
			}
			claim := h.req
			claim.Operation = "claim_inputs"
			claim.LastSeq = e.Seq
			if out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim); err != nil || out.(projectagent.Claim).Event != nil {
				t.Fatal("重复投递", err)
			}
		})
	}
}

func TestProjectExecWaitDeadlineTerminalRace(t *testing.T) {
	for i := 0; i < 12; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			h, req, p := execWaitFixture(t, 0)
			startProjectShell(t, h, p.ThreadID)
			var wg sync.WaitGroup
			wg.Add(1)
			go func() {
				defer wg.Done()
				finishProjectShell(t, h, p.ThreadID, "command-output", json.RawMessage(`{"exit_code":0}`))
			}()
			wait := req
			wait.Operation = "wait_tool"
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, wait)
			wg.Wait()
			if err != nil {
				t.Fatal(err)
			}
			e := out.(projectagent.Event)
			raw, _ := toolText(t, e)
			returned := strings.Contains(string(raw), "command_result")
			var delivered *int64
			if err = h.pool.QueryRow(h.ctx, `SELECT delivered_seq FROM project_agent_input_queue WHERE source_key=$1`, "thread:"+p.ThreadID+":turn:1").Scan(&delivered); err != nil {
				t.Fatal(err)
			}
			if returned != (delivered != nil) || (delivered != nil && *delivered != e.Seq) {
				t.Fatal("重复或遗漏", string(raw), delivered)
			}
			if !returned {
				claim := h.req
				claim.Operation = "claim_inputs"
				claim.LastSeq = e.Seq
				next, err := h.repo.ProjectRuntime(h.ctx, h.src, claim)
				if err != nil || next.(projectagent.Claim).InputCount != 2 || !strings.Contains(string(next.(projectagent.Claim).Event.Payload), "command-output") {
					t.Fatal("异步结果丢失", err)
				}
			}
		})
	}
}
