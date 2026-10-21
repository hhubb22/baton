package pi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"baton/internal/agent"
	"baton/internal/agent/pi/pireplaytest"
	"baton/internal/agent/replay"
)

func appendThreadHistory(t *testing.T, a *Adapter, role string, content any) {
	t.Helper()
	f, err := os.OpenFile(a.history.File, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	err = json.NewEncoder(f).Encode(map[string]any{"type": "message", "message": map[string]any{"role": role, "content": content}})
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("写入历史: %v %v", err, closeErr)
	}
}

func TestThreadSentUsesPersistedUserPosition(t *testing.T) {
	a := historyAdapter(t)
	appendThreadHistory(t, a, "user", "重复正文")
	appendThreadHistory(t, a, "assistant", "回复")
	count, err := a.UserMessageCount()
	if err != nil || count != 1 {
		t.Fatalf("user 消息数量: %d %v", count, err)
	}
	a.RestoreIntent("new", "重复正文", count)
	if sent, err := a.Sent("new"); err != nil || sent {
		t.Fatalf("把旧消息当作新消息: %v %v", sent, err)
	}
	appendThreadHistory(t, a, "assistant", "重复正文")
	if sent, err := a.Sent("new"); err != nil || sent {
		t.Fatalf("把 assistant 当作 user: %v %v", sent, err)
	}
	appendThreadHistory(t, a, "user", []map[string]string{{"type": "text", "text": "重复"}, {"type": "text", "text": "正文"}})
	restored := New(a.config)
	if err := restored.loadMapping(); err != nil {
		t.Fatal(err)
	}
	restored.RestoreIntent("new", "重复正文", count)
	if sent, err := restored.Sent("new"); err != nil || !sent {
		t.Fatalf("重启后未找到持久化消息: %v %v", sent, err)
	}
	restored.RestoreIntent("absent", "未发送", count)
	if sent, err := restored.Sent("absent"); err != nil || sent {
		t.Fatalf("误报不存在的正文: %v %v", sent, err)
	}
	if _, err := restored.Sent("unknown"); err == nil {
		t.Fatal("缺少 intent 却核实了发送")
	}
	if err := os.Remove(a.history.File); err != nil {
		t.Fatal(err)
	}
	if _, err := restored.UserMessageCount(); !errors.Is(err, ErrHistoryMissing) {
		t.Fatalf("历史缺失: %v", err)
	}
	if sent, err := restored.Sent("new"); sent || !errors.Is(err, ErrHistoryMissing) {
		t.Fatalf("历史缺失仍确认发送: %v %v", sent, err)
	}
}

type threadRPCWriter struct {
	write func([]byte) error
}

func (w threadRPCWriter) Write(p []byte) (int, error) { return len(p), w.write(p) }
func (w threadRPCWriter) Close() error                { return nil }

func TestThreadRejectedPromptAndNextTurn(t *testing.T) {
	a := historyAdapter(t)
	if err := os.Remove(a.history.File); err != nil {
		t.Fatal(err)
	}
	a.freshHistory = true
	a.done = make(chan struct{})
	attempts := 0
	a.in = threadRPCWriter{write: func(raw []byte) error {
		var command struct{ ID, Type string }
		if err := json.Unmarshal(raw, &command); err != nil {
			return err
		}
		if command.Type != "prompt" {
			return errors.New("unexpected RPC command")
		}
		attempts++
		if attempts == 2 {
			header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": a.config.SessionID, "cwd": a.config.Directory})
			if err := os.WriteFile(a.history.File, append(header, '\n'), 0600); err != nil {
				return err
			}
		}
		raw, _ = json.Marshal(map[string]any{"type": "response", "id": command.ID, "command": command.Type, "success": attempts > 1, "data": map[string]string{"disposition": "started"}})
		if err := a.consume(raw); err != nil || attempts == 1 {
			return err
		}
		// These frames can arrive before the Send caller resumes.
		if err := a.consume([]byte(`{"type":"message_end","message":{"role":"assistant","content":"完成","stopReason":"stop"}}`)); err != nil {
			return err
		}
		return a.consume([]byte(`{"type":"agent_settled"}`))
	}}
	if err := a.Send(context.Background(), "rejected", "正文"); err == nil {
		t.Fatal("prompt 被拒绝却返回成功")
	}
	if a.active || len(a.DrainEvents()) != 0 {
		t.Fatal("被拒绝的 prompt 开启了 Turn")
	}
	for _, id := range []string{"first", "second"} {
		if err := a.Send(context.Background(), id, "正文"); err != nil {
			t.Fatal(err)
		}
		waitPi(t, func() bool {
			a.mu.Lock()
			defer a.mu.Unlock()
			return !a.active
		})
		got := a.DrainEvents()
		want := []agent.Event{
			{Kind: agent.EventTurnStarted, ClientMessageID: id, NativeSessionID: a.config.SessionID},
			{Kind: agent.EventReply, Content: "完成"},
			{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("快速回复的 Turn 事件: %+v", got)
		}
	}
}

func TestThreadLateAcceptanceAfterUnconfirmedWrite(t *testing.T) {
	a := historyAdapter(t)
	a.done = make(chan struct{})
	requestID := make(chan string, 1)
	a.in = threadRPCWriter{write: func(raw []byte) error {
		var command struct{ ID string }
		if err := json.Unmarshal(raw, &command); err != nil {
			return err
		}
		requestID <- command.ID
		return errors.New("write outcome unknown")
	}}
	if err := a.Send(context.Background(), "late", "正文"); err == nil {
		t.Fatal("没有收到确认却返回成功")
	}
	id := <-requestID
	if got := a.DrainEvents(); len(got) != 1 || got[0].Kind != agent.EventUncertain || got[0].ClientMessageID != "late" {
		t.Fatalf("发送结果不明时没有报告 uncertain: %+v", got)
	}
	if err := a.Send(context.Background(), "duplicate", "正文"); !errors.Is(err, agent.ErrBusy) {
		t.Fatalf("确认丢失后允许再次发送: %v", err)
	}
	raw, _ := json.Marshal(map[string]any{"type": "response", "id": id, "command": "prompt", "success": true, "data": map[string]string{"disposition": "started"}})
	if err := a.consume(raw); err != nil {
		t.Fatal(err)
	}
	if got := a.DrainEvents(); len(got) != 1 || got[0].Kind != agent.EventTurnStarted || got[0].ClientMessageID != "late" {
		t.Fatalf("迟到的接受事件丢失: %+v", got)
	}
}

func TestThreadExitReportsUncertaintyWithoutSettlement(t *testing.T) {
	for _, active := range []bool{false, true} {
		a := New(agent.Config{SessionID: "original"})
		a.active, a.threadTurn = active, active
		a.mu.Lock()
		a.processExitedLocked(nil)
		a.mu.Unlock()
		want := []agent.Event{{Kind: agent.EventExited, NativeSessionID: "original"}}
		if active {
			want = append([]agent.Event{{Kind: agent.EventUncertain, Reason: "Pi process exited before settlement"}}, want...)
		}
		if got := a.DrainEvents(); !reflect.DeepEqual(got, want) {
			t.Fatalf("进程退出 active=%v: %+v", active, got)
		}
	}
}

func TestThreadConcurrentIntentAccess(t *testing.T) {
	a := historyAdapter(t)
	appendThreadHistory(t, a, "user", "正文")
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 20 {
				a.RestoreIntent("message", "正文", 0)
				if sent, err := a.Sent("message"); !sent || err != nil {
					t.Errorf("并发核实发送: %v %v", sent, err)
				}
			}
		})
	}
	wg.Wait()
}

func TestThreadSettlementReasons(t *testing.T) {
	for _, tc := range []struct {
		name, stopReason, want string
		aborting, aborted      bool
	}{
		{name: "completed", stopReason: "stop", want: agent.EndCompleted},
		{name: "failed", stopReason: "error", want: agent.EndFailed},
		{name: "abort requested", stopReason: "stop", aborting: true, want: agent.EndStopped},
		{name: "aborted event", stopReason: "stop", aborted: true, want: agent.EndStopped},
		{name: "aborted message", stopReason: "aborted", want: agent.EndStopped},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := New(agent.Config{})
			a.active, a.threadTurn, a.threadStarted = true, true, true
			a.stopReason, a.aborting, a.settled = tc.stopReason, tc.aborting, make(chan struct{})
			raw, _ := json.Marshal(map[string]any{"type": "agent_settled", "aborted": tc.aborted})
			if err := a.consume(raw); err != nil {
				t.Fatal(err)
			}
			if events := a.DrainEvents(); len(events) != 1 || events[0].Kind != agent.EventTurnEnded || events[0].Reason != tc.want {
				t.Fatalf("结束事件: %+v", events)
			}
			if len(a.DrainEvents()) != 0 || len(a.Drain()) != 0 {
				t.Fatal("重复报告或产生旧任务结果")
			}
			if err := a.consume(raw); err != nil || len(a.DrainEvents()) != 0 {
				t.Fatal("重复 settled 产生第二次结束事件")
			}
		})
	}
}

// threadTape extends the recorded startup with deterministic Thread RPC frames.
func threadTape(t *testing.T) replay.Transcript {
	t.Helper()
	tape := pireplaytest.Tape(t, "testdata/replay", "startup")
	tape.Entries = tape.Entries[:len(tape.Entries)-1]
	const file = "<fixture>/probe/native/2026-10-19T09-39-38-131Z_<$session_id_1>.jsonl"
	frame := func(kind, label, raw string) {
		tape.Entries = append(tape.Entries, replay.Entry{Type: kind, Process: 2, Label: label, Frame: json.RawMessage(raw)})
	}
	history := func(label, raw string) {
		tape.Entries = append(tape.Entries, replay.Entry{Type: "native_history", Process: 2, Label: label, Path: file, Append: raw + "\n"})
	}
	frame("expect_outbound", "request:prompt", `{"id":"<$request_id_3>","type":"prompt","message":"开始"}`)
	frame("emit_inbound", "response:prompt", `{"type":"response","command":"prompt","id":"<$request_id_3>","success":true,"data":{"disposition":"started"}}`)
	history("history:initial", `{"type":"session","version":3,"id":"<$session_id_1>","cwd":"<workspace>"}`+"\n"+`{"type":"message","message":{"role":"user","content":"开始"}}`)
	frame("emit_inbound", "event:first-reply", `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"第一条"},{"type":"toolCall","name":"read"}],"stopReason":"toolUse"}}`)
	frame("expect_outbound", "request:steer", `{"id":"<$request_id_4>","type":"steer","message":"补充"}`)
	frame("emit_inbound", "response:steer", `{"type":"response","command":"steer","id":"<$request_id_4>","success":true}`)
	history("history:steer", `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"补充"}]}}`)
	frame("emit_inbound", "event:second-reply", `{"type":"message_end","message":{"role":"assistant","content":"第二条","stopReason":"stop"}}`)
	frame("expect_outbound", "request:clear_queue", `{"id":"<$request_id_5>","type":"clear_queue"}`)
	frame("emit_inbound", "response:clear_queue", `{"type":"response","command":"clear_queue","id":"<$request_id_5>","success":true}`)
	frame("expect_outbound", "request:abort", `{"id":"<$request_id_6>","type":"abort"}`)
	frame("emit_inbound", "response:abort", `{"type":"response","command":"abort","id":"<$request_id_6>","success":true}`)
	frame("emit_inbound", "event:agent_settled", `{"type":"agent_settled","aborted":true}`)
	tape.Entries = append(tape.Entries, replay.Entry{Type: "runtime_exit", Process: 2, Label: "process:thread-exit"})
	return tape
}

func TestThreadRPCReplay(t *testing.T) {
	binary := pireplaytest.Build(t, "../../../tools/agent-replay")
	tape := threadTape(t)
	gates := []string{"event:first-reply", "event:second-reply", "process:thread-exit"}
	f := pireplaytest.New(t, binary, tape, t.TempDir(), "11111111-1111-4111-8111-111111111111", t.TempDir(), gates...)
	a := New(f.Agent)
	defer func() {
		for _, gate := range gates {
			f.Release(t, gate)
		}
		_ = a.Close()
	}()
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.Capabilities() != (agent.Capabilities{Steer: true, Resume: true}) || a.NativeSessionID() != f.Agent.SessionID {
		t.Fatal("能力或原生会话 ID 错误")
	}
	prompt := ""
	for i, arg := range a.cmd.Args {
		if arg == "--append-system-prompt" {
			prompt = a.cmd.Args[i+1]
		}
	}
	if !strings.Contains(prompt, "Baton Thread") || !strings.Contains(prompt, a.config.Directory) || strings.Contains(prompt, "JSON") || strings.Contains(prompt, "delegat") {
		t.Fatalf("Thread 系统提示: %s", prompt)
	}
	if count, err := a.UserMessageCount(); count != 0 || err != nil {
		t.Fatalf("新会话尚无 JSONL: %d %v", count, err)
	}
	if err := a.Steer(context.Background(), "early", "补充"); err == nil {
		t.Fatal("空闲时接受 steer")
	}
	if err := a.Send(context.Background(), "first", "开始"); err != nil {
		t.Fatal(err)
	}
	f.Wait(t, "event:first-reply")
	if err := a.Send(context.Background(), "busy", "排队"); !errors.Is(err, agent.ErrBusy) {
		t.Fatalf("忙时 Send: %v", err)
	}
	if sent, err := a.Sent("first"); !sent || err != nil {
		t.Fatalf("prompt 未落盘: %v %v", sent, err)
	}
	f.Release(t, "event:first-reply")
	if err := a.Steer(context.Background(), "steering", "补充"); err != nil {
		t.Fatal(err)
	}
	f.Wait(t, "event:second-reply")
	if count, err := a.UserMessageCount(); count != 2 || err != nil {
		t.Fatalf("steer 历史数量: %d %v", count, err)
	}
	if sent, err := a.Sent("steering"); !sent || err != nil {
		t.Fatalf("steer 未落盘: %v %v", sent, err)
	}
	f.Release(t, "event:second-reply")
	stopped, known, err := a.Abort()
	if err != nil || !stopped || !known {
		t.Fatalf("停止未确认: %v %v %v", stopped, known, err)
	}
	f.Wait(t, "process:thread-exit")
	want := []agent.Event{
		{Kind: agent.EventTurnStarted, ClientMessageID: "first", NativeSessionID: f.Agent.SessionID},
		{Kind: agent.EventReply, Content: "第一条"},
		{Kind: agent.EventReply, Content: "第二条"},
		{Kind: agent.EventTurnEnded, Reason: agent.EndStopped},
	}
	if got := a.DrainEvents(); !reflect.DeepEqual(got, want) {
		t.Fatalf("事件顺序: %+v", got)
	}
	if len(a.DrainEvents()) != 0 {
		t.Fatal("重复消费事件")
	}
}

func TestThreadRestoreReplay(t *testing.T) {
	binary := pireplaytest.Build(t, "../../../tools/agent-replay")
	tape := pireplaytest.Tape(t, "testdata/replay", "restore_load_only")
	gates := []string{pireplaytest.LastExit(tape, 2), pireplaytest.LastExit(tape, 4)}
	f := pireplaytest.New(t, binary, tape, t.TempDir(), "11111111-1111-4111-8111-111111111111", t.TempDir(), gates...)
	a := New(f.Agent)
	defer func() {
		for _, gate := range gates {
			f.Release(t, gate)
		}
		_ = a.Close()
	}()
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	count, err := a.UserMessageCount()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Send(context.Background(), "original", "<any>"); err != nil {
		t.Fatal(err)
	}
	f.Wait(t, gates[0])
	waitPi(t, func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return !a.active
	})
	file, sid := a.history.File, a.NativeSessionID()
	_ = a.Close()
	config := f.Agent
	config.Restore = true
	a = New(config)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.Wait(t, gates[1])
	if a.history.File != file || a.NativeSessionID() != sid || len(a.DrainEvents()) != 0 {
		t.Fatal("恢复改变了原生会话或启动了新 Turn")
	}
	a.RestoreIntent("original", "<any>", count)
	if sent, err := a.Sent("original"); !sent || err != nil {
		t.Fatalf("恢复后未确认原消息: %v %v", sent, err)
	}
}
