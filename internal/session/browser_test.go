package session

import (
	"baton/internal/agent"
	"baton/internal/protocol"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

type browserStub struct {
	*nativeStub
	calls int
	fail  bool
}

func (a *browserStub) Supplement(context.Context, string, string) error {
	a.calls++
	if a.fail {
		return context.DeadlineExceeded
	}
	return nil
}

func TestBrowserOutputBoundedAndGap(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	w.appendLiveLocked(strings.Repeat("中文", 100000), false)
	if len(w.liveText) > protocol.SessionBufferBytes || !utf8.ValidString(w.liveText) {
		t.Fatal("输出缓存超限或截断 UTF-8")
	}
	req := protocol.SessionRequest{SessionID: sid, OperationID: mustSessionID(t), Action: "output"}
	result := w.sessionRequest(sid, req)
	if !result.OK || !result.Gap || len(result.Text) > protocol.SessionOutputBytes || !utf8.ValidString(result.Text) {
		t.Fatalf("输出页无效: %+v", result)
	}
	req.Cursor = result.Cursor
	next := w.sessionRequest(sid, req)
	if !next.OK || next.Gap || next.Cursor == result.Cursor {
		t.Fatal("有效游标没有继续输出")
	}
	req.Cursor = mustSessionID(t) + ":0"
	if got := w.sessionRequest(sid, req); !got.Gap {
		t.Fatal("Worker 代次变化没有报告缺口")
	}
	req.Cursor = "bad"
	if got := w.sessionRequest(sid, req); got.OK || got.Code != "invalid_cursor" {
		t.Fatal("接受了无效游标")
	}
}

func TestBrowserInputReceiptDoesNotReplay(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "确认", true: "确认丢失"}[fail], func(t *testing.T) {
			w, _, sid := clockWorker(t, 60)
			stub := &browserStub{nativeStub: &nativeStub{}, fail: fail}
			w.adapterFactory = func(string, string) (agent.Adapter, error) { return stub, nil }
			if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
				t.Fatal(err)
			}
			req := protocol.SessionRequest{OperationID: mustSessionID(t), SessionID: sid, Action: "input", Text: "补充说明"}
			result := w.sessionRequest(sid, req)
			if result.OK == fail {
				t.Fatal("输入确认状态错误")
			}
			again := w.sessionRequest(sid, req)
			if again.OK != result.OK || stub.calls != 1 {
				t.Fatal("相同操作重复提交到了 Agent")
			}
			req.Action = "input_status"
			query := w.sessionRequest(sid, req)
			if query.OK != result.OK || stub.calls != 1 {
				t.Fatal("查询重放了输入")
			}
			req.Action = "input"
			req.Text = "另一个输入"
			if got := w.sessionRequest(sid, req); got.Code != "operation_conflict" || stub.calls != 1 {
				t.Fatal("相同操作接受了不同正文")
			}
		})
	}
}

func TestBrowserInputRejectsEndedAndUnsupportedSession(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	req := protocol.SessionRequest{OperationID: mustSessionID(t), SessionID: sid, Action: "input", Text: "新目标"}
	if got := w.sessionRequest(sid, req); got.Code != "unsupported" {
		t.Fatal("不支持输入的执行器接受了输入")
	}
	stub := &browserStub{nativeStub: &nativeStub{}}
	w.adapter = stub
	w.resultDelivered = true
	if got := w.sessionRequest(sid, req); got.Code != "session_not_active" || stub.calls != 0 {
		t.Fatal("已结束任务收到补充输入")
	}
}

func TestBrowserResumeAllowsOnlyNewExecutionAfterAcknowledgedResult(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	w.dataDir = t.TempDir()
	a := &nativeStub{}
	w.adapterFactory = func(string, string) (agent.Adapter, error) { return a, nil }
	if _, err := w.SubmitInput(sid, nativeTestInput); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(agent.Config{SessionID: sid, ExecutionID: w.execution, Directory: t.TempDir(), SessionDir: t.TempDir()})
	if _, err := w.db.Exec(`INSERT INTO meta(key,value) VALUES('adapter_config',?)`, string(config)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.db.Exec(`INSERT INTO child_deliveries(delivery_id,child_task_id,payload,status,input_generation) VALUES(?,?,?,'delivered',1)`, mustSessionID(t), mustSessionID(t), `{}`); err != nil {
		t.Fatal(err)
	}
	a.outputs = []Output{{Exited: true, Final: successDocument()}}
	if err := w.checkDeadline(sid); err != nil {
		t.Fatal(err)
	}
	newTask, newExecution := mustSessionID(t), mustSessionID(t)
	if err := w.Bind(newTask, newExecution, "pi"); err != ErrSessionBusy {
		t.Fatal("未显式恢复就复用了已结束执行")
	}
	pending, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range pending {
		if err := w.Ack(r.EventID); err != nil {
			t.Fatal(err)
		}
	}
	req := protocol.SessionRequest{SessionID: sid, OperationID: mustSessionID(t), Action: "resume"}
	if result := w.sessionRequest(sid, req); !result.OK || result.State != "idle" {
		t.Fatal("已交付结果的原 Session 没有恢复为空闲")
	}
	if err := w.Bind(newTask, newExecution, "pi"); err != nil {
		t.Fatal(err)
	}
	if w.intent || w.inputSubmitted || w.resultDelivered || w.execution != newExecution || w.task != newTask {
		t.Fatal("新执行继承了旧执行的启动状态")
	}
	var saved string
	if err := w.db.QueryRow(`SELECT value FROM meta WHERE key='adapter_config'`).Scan(&saved); err != nil {
		t.Fatal(err)
	}
	var got agent.Config
	if json.Unmarshal([]byte(saved), &got) != nil || got.SessionID != sid || got.ExecutionID != newExecution || !got.Restore {
		t.Fatal("新执行丢失原生 Session 映射")
	}
	if receipts, err := w.ChildReceipts(); err != nil || len(receipts) != 0 {
		t.Fatal("旧子结果回执泄漏进新执行")
	}
	if pending, err := w.Pending(); err != nil || len(pending) != 0 {
		t.Fatal("旧执行报告泄漏进新执行")
	}
}

func TestBrowserFixedDirectory(t *testing.T) {
	w, _, sid := clockWorker(t, 60)
	directory := t.TempDir()
	config, _ := json.Marshal(agent.Config{Directory: directory})
	if _, err := w.db.Exec(`INSERT INTO meta(key,value) VALUES('adapter_config',?)`, string(config)); err != nil {
		t.Fatal(err)
	}
	req := protocol.SessionRequest{SessionID: sid, OperationID: mustSessionID(t), Action: "validate_directory", Text: directory}
	if got := w.sessionRequest(sid, req); !got.OK {
		t.Fatal("原工作目录被拒绝")
	}
	req.Text = t.TempDir()
	if got := w.sessionRequest(sid, req); got.OK || got.Code != "invalid_directory" {
		t.Fatal("目录不一致没有拒绝")
	}
}
