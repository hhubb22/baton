package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/monotime"
	"baton/internal/protocol"
)

type threadFake struct {
	mu                          sync.Mutex
	events                      []agent.Event
	sends, steers               []string
	sent                        map[string]bool
	restores                    map[string]int
	configs                     []agent.Config
	model                       string
	models                      []string
	switchModel                 bool
	switchErr                   error
	steer, resume, killKnown    bool
	startErr, sendErr, abortErr error
	abortEvents                 bool
	abortCalled                 chan struct{}
	kills                       int
}

func (a *threadFake) Start(context.Context) error { return a.startErr }
func (a *threadFake) Send(_ context.Context, id, text, model string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if model != "" && model != a.model && a.switchErr != nil {
		return &agent.ModelSwitchError{Err: a.switchErr}
	}
	if model != "" {
		a.model = model
	}
	a.models = append(a.models, a.model)
	a.sends = append(a.sends, id)
	if a.sent == nil {
		a.sent = map[string]bool{}
	}
	a.sent[id] = true
	return a.sendErr
}
func (a *threadFake) Steer(_ context.Context, id, text string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steers = append(a.steers, id)
	return nil
}
func (a *threadFake) Sent(id string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sent[id], nil
}
func (a *threadFake) Drain() []agent.Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	events := a.events
	a.events = nil
	return events
}
func (a *threadFake) Abort() (bool, bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.abortEvents {
		a.events = append(a.events, agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
	}
	if a.abortCalled != nil {
		close(a.abortCalled)
		a.abortCalled = nil
	}
	return false, false, a.abortErr
}
func (a *threadFake) Close() error { return nil }
func (a *threadFake) ReadHistory(context.Context, string) (agent.HistoryPage, error) {
	return agent.HistoryPage{Data: json.RawMessage(`[]`)}, nil
}
func (a *threadFake) Capabilities() agent.Capabilities {
	return agent.Capabilities{Steer: a.steer, Resume: a.resume, SwitchModel: a.switchModel}
}
func (a *threadFake) NativeSessionID() string        { return "native-session" }
func (a *threadFake) UserMessageCount() (int, error) { return 7, nil }
func (a *threadFake) RestoreIntent(id, text string, count int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.restores == nil {
		a.restores = map[string]int{}
	}
	a.restores[id] = count
}
func (a *threadFake) KillProcessTree() (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.kills++
	return a.killKnown, nil
}
func (a *threadFake) add(events ...agent.Event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, events...)
}
func (a *threadFake) factory(kind string, config agent.Config) (agent.Adapter, error) {
	a.configs = append(a.configs, config)
	a.model = config.Model
	return a, nil
}

func newThreadTestWorker(t *testing.T, change func(*ThreadOptions), a *threadFake) *ThreadWorker {
	t.Helper()
	data, root := t.TempDir(), t.TempDir()
	if err := fileaccess.AddBrowseRoot(data, "dev", root); err != nil {
		t.Fatal(err)
	}
	options := ThreadOptions{ThreadID: mustSessionID(t), StorageGeneration: mustSessionID(t), NodeID: mustSessionID(t), AgentType: "pi", WorkingDirectory: root, StopTimeout: 2 * time.Second}
	if change != nil {
		change(&options)
	}
	if a == nil {
		a = &threadFake{steer: true, resume: true, killKnown: true}
	}
	w, err := OpenThreadWorker(context.Background(), data, options, a.factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return w
}
func threadMust(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func threadMessage(t *testing.T, w *ThreadWorker, id, mode string) {
	t.Helper()
	threadMust(t, w.EnqueueThreadMessage(context.Background(), id, "content "+id, mode, ""))
}
func threadReports(t *testing.T, w *ThreadWorker) []protocol.ThreadReport {
	t.Helper()
	r, err := w.ThreadPending(0)
	threadMust(t, err)
	return r
}
func threadCount(t *testing.T, w *ThreadWorker, query string, args ...any) int {
	t.Helper()
	var n int
	threadMust(t, w.db.QueryRow(query, args...).Scan(&n))
	return n
}
func threadState(t *testing.T, w *ThreadWorker) string {
	t.Helper()
	state, err := w.status()
	threadMust(t, err)
	return state
}

func TestThreadQueueSteerWithdrawAndOutbox(t *testing.T) {
	a := &threadFake{steer: true, resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	for _, id := range []string{"q1", "q2", "q3"} {
		threadMessage(t, w, id, "queue")
	}
	threadMessage(t, w, "insert", "steer")
	threadMust(t, w.WithdrawThreadMessage("q2"))
	threadMust(t, w.WithdrawThreadMessage("q2"))
	if err := w.WithdrawThreadMessage("first"); err == nil {
		t.Fatal("withdrew sent message")
	}
	threadMessage(t, w, "first", "queue")
	if err := w.EnqueueThreadMessage(context.Background(), "first", "different", "queue", ""); err == nil {
		t.Fatal("accepted ID conflict")
	}
	for range 3 {
		a.add(agent.Event{Kind: agent.EventReply, Content: "reply"}, agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
		threadMust(t, w.Poll(context.Background()))
	}
	if !reflect.DeepEqual(a.sends, []string{"first", "q1", "q3"}) || !reflect.DeepEqual(a.steers, []string{"insert"}) {
		t.Fatalf("sends=%v steers=%v", a.sends, a.steers)
	}
	if state := threadState(t, w); state != "idle" {
		t.Fatal(state)
	}
	reports := threadReports(t, w)
	lastReply, lastEnd := int64(0), int64(0)
	for i, r := range reports {
		if r.WorkerSeq != int64(i+1) || r.EventID == "" {
			t.Fatalf("non-contiguous report: %+v", r)
		}
		if r.Kind == "reply" {
			lastReply = r.WorkerSeq
		}
		if r.Kind == "turn.ended" {
			if lastReply <= lastEnd || lastReply >= r.WorkerSeq {
				t.Fatal("turn ended before replies")
			}
			lastEnd = r.WorkerSeq
		}
	}
	if reports[0].Kind != "thread.opened" || reports[0].NativeSessionID != "native-session" {
		t.Fatal(reports[0])
	}
	if !reports[len(reports)-1].QueueEmpty {
		t.Fatal("last queue_empty=false")
	}
	threadMust(t, w.ThreadAck(reports[0].EventID, reports[0].WorkerSeq))
	if err := w.ThreadAck(reports[1].EventID, reports[2].WorkerSeq); err == nil {
		t.Fatal("accepted mismatched ACK")
	}
	threadMust(t, w.ThreadAck(reports[1].EventID, 0))
	threadMust(t, w.ThreadAck("", reports[2].WorkerSeq))
	tail, err := w.ThreadPending(3)
	threadMust(t, err)
	if len(tail) != len(reports)-3 || tail[0].WorkerSeq != 4 {
		t.Fatalf("pending=%+v", tail)
	}
}

func TestThreadUnsupportedSteerAndIdleFallback(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "steer")
	if err := w.EnqueueThreadMessage(context.Background(), "insert", "hello", "steer", ""); !errors.Is(err, agent.ErrUnsupported) {
		t.Fatalf("steer error=%v", err)
	}
	if n := threadCount(t, w, `SELECT COUNT(*) FROM thread_messages`); n != 1 {
		t.Fatal(n)
	}
}

func TestThreadIntentCrashRecoveryNeverResends(t *testing.T) {
	for _, found := range []bool{true, false} {
		t.Run(map[bool]string{true: "sent", false: "unknown"}[found], func(t *testing.T) {
			a := &threadFake{resume: true}
			w := newThreadTestWorker(t, nil, a)
			// 故障点：发送意图已提交，适配器确认尚未落账。
			threadMust(t, w.transaction(func(tx *sql.Tx) error {
				_, err := tx.Exec(`INSERT INTO thread_messages(client_message_id,mode,content,status,turn_seq,intent_user_count) VALUES('crash','queue','body','intent',1,7)`)
				return err
			}))
			data, options := w.dataDir, w.options
			threadMust(t, w.Close())
			b := &threadFake{resume: true, sent: map[string]bool{"crash": found}}
			if found {
				b.add(agent.Event{Kind: agent.EventReply, Content: "saved reply"}, agent.Event{Kind: agent.EventTurnEnded})
			}
			restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
			threadMust(t, err)
			defer restored.Close()
			if len(b.sends) != 0 || b.restores["crash"] != 7 || !b.configs[0].Restore {
				t.Fatalf("recovery resent or lost intent: %+v", b)
			}
			expected := "unknown"
			if found {
				expected = "sent"
			}
			var status string
			threadMust(t, restored.db.QueryRow(`SELECT status FROM thread_messages WHERE client_message_id='crash'`).Scan(&status))
			if status != expected {
				t.Fatalf("status=%s", status)
			}
			if !found && threadState(t, restored) != "unknown" {
				t.Fatal("missing unknown state")
			}
			threadMust(t, restored.Poll(context.Background()))
			if len(b.sends) != 0 {
				t.Fatal("poll resent intent")
			}
		})
	}
}

func TestThreadActiveTurnRecoveryEndsBeforeUnknown(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	b := &threadFake{resume: true}
	restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	r := threadReports(t, restored)
	if r[len(r)-2].Kind != "turn.ended" || r[len(r)-2].Reason != agent.EndAgentExited || r[len(r)-1].Kind != "thread.unknown" {
		t.Fatalf("recovery reports=%+v", r)
	}
	threadMessage(t, restored, "next", "queue")
	if !reflect.DeepEqual(b.sends, []string{"next"}) || !b.configs[len(b.configs)-1].Restore {
		t.Fatal("did not restore original session")
	}
}

func TestThreadStopAndExecutionTimeout(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(map[bool]string{true: "timeout", false: "stopped"}[timeout], func(t *testing.T) {
			a := &threadFake{resume: true, abortEvents: true, abortCalled: make(chan struct{})}
			done := a.abortCalled
			w := newThreadTestWorker(t, func(o *ThreadOptions) { o.ExecutionTimeoutSeconds = 2 }, a)
			clock := monotime.NewManual(time.Now())
			w.clock = clock
			threadMessage(t, w, "first", "queue")
			threadMessage(t, w, "queued", "queue")
			if timeout {
				clock.JumpWall(-time.Hour)
				clock.Suspend(2 * time.Second)
				threadMust(t, w.Poll(context.Background()))
			} else {
				threadMust(t, w.StopThread(agent.EndStopped))
			}
			<-done
			threadMust(t, w.Poll(context.Background()))
			if threadState(t, w) != "idle" || len(a.sends) != 1 || threadCount(t, w, `SELECT COUNT(*) FROM thread_messages WHERE status='withdrawn'`) != 1 {
				t.Fatal("stop did not withdraw queue and settle")
			}
			r := threadReports(t, w)
			last := r[len(r)-1]
			expected := agent.EndStopped
			if timeout {
				expected = agent.EndTimeout
			}
			if last.Kind != "turn.ended" || last.Reason != expected || !last.QueueEmpty {
				t.Fatalf("last=%+v", last)
			}
		})
	}
}

func TestThreadForcedStopEvidenceAndAbortError(t *testing.T) {
	for _, known := range []bool{true, false} {
		for _, abortError := range []bool{true, false} {
			t.Run(strings.Join([]string{map[bool]string{true: "known", false: "unknown"}[known], map[bool]string{true: "abort_error", false: "deadline"}[abortError]}, "/"), func(t *testing.T) {
				a := &threadFake{resume: true, killKnown: known, abortCalled: make(chan struct{})}
				if abortError {
					a.abortErr = errors.New("abort failed")
				}
				done := a.abortCalled
				w := newThreadTestWorker(t, nil, a)
				clock := monotime.NewManual(time.Now())
				w.clock = clock
				threadMessage(t, w, "first", "queue")
				threadMessage(t, w, "queued", "queue")
				threadMust(t, w.StopThread(agent.EndStopped))
				<-done
				if !abortError {
					clock.Suspend(2 * time.Second)
				}
				threadMust(t, w.Poll(context.Background()))
				expected := "unknown"
				if known {
					expected = "stopped"
				}
				if threadState(t, w) != expected || a.kills != 1 {
					t.Fatalf("state=%s kills=%d", threadState(t, w), a.kills)
				}
				r := threadReports(t, w)
				if r[len(r)-2].Kind != "turn.ended" || r[len(r)-2].Reason != agent.EndStopped {
					t.Fatal("forced stop lost turn boundary")
				}
			})
		}
	}
}

func TestThreadReplyCommitFailureRetainsEventsAndUTF8(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	// 延迟外键约束在 COMMIT 才失败，验证独立连接不读到部分回复。
	_, err := w.db.Exec(`CREATE TABLE thread_commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE thread_commit_child(id INTEGER REFERENCES thread_commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_thread_reply AFTER INSERT ON thread_replies BEGIN INSERT INTO thread_commit_child VALUES(1); END;`)
	threadMust(t, err)
	text := strings.Repeat("你好", 10000)
	a.add(agent.Event{Kind: agent.EventReply, Content: text}, agent.Event{Kind: agent.EventTurnEnded})
	for range 2 {
		if err := w.Poll(context.Background()); err == nil {
			t.Fatal("accepted failed commit")
		}
		if len(w.events) != 2 || threadCount(t, w, `SELECT COUNT(*) FROM thread_replies`) != 0 {
			t.Fatal("lost event or partially committed reply")
		}
	}
	_, err = w.db.Exec(`DROP TRIGGER fail_thread_reply`)
	threadMust(t, err)
	threadMust(t, w.Poll(context.Background()))
	if threadCount(t, w, `SELECT COUNT(*) FROM thread_replies`) != 1 {
		t.Fatal("reply count")
	}
	r := threadReports(t, w)
	reply := r[len(r)-2]
	if reply.Kind != "reply" || !reply.Truncated || reply.OriginalBytes != int64(len(text)) || len(reply.Content) > 32<<10 || !utf8.ValidString(reply.Content) || !strings.HasPrefix(text, reply.Content[:len(reply.Content)/2]) {
		t.Fatalf("truncation=%+v", reply)
	}
	if r[len(r)-1].Kind != "turn.ended" {
		t.Fatal("ended before reply")
	}
}

func TestThreadOpenFailureAndMissingHistory(t *testing.T) {
	a := &threadFake{startErr: agent.ErrHistoryMissing, resume: true}
	w := newThreadTestWorker(t, nil, a)
	r := threadReports(t, w)
	if len(r) != 1 || r[0].Kind != "thread.open_failed" || r[0].Reason == "" {
		t.Fatal(r)
	}
	if err := w.EnqueueThreadMessage(context.Background(), "retry", "message", "queue", ""); !errors.Is(err, agent.ErrHistoryMissing) {
		t.Fatalf("missing history error=%v", err)
	}
	if len(a.sends) != 0 || threadState(t, w) != "stopped" {
		t.Fatal("started empty session")
	}
}

type liveThreadFake struct {
	*threadFake
	text string
}

func (a *liveThreadFake) DrainLive() (string, bool) { text := a.text; a.text = ""; return text, false }
func newThreadOutputRequest(t *testing.T, w *ThreadWorker, cursor string) protocol.SessionRequest {
	t.Helper()
	return protocol.SessionRequest{Type: protocol.BodySessionRequest, OperationID: mustSessionID(t), SessionID: w.options.ThreadID, Action: "output", Cursor: cursor}
}

func TestThreadUnknownStopWithoutKnownTurn(t *testing.T) {
	a := &threadFake{resume: true, killKnown: true, abortCalled: make(chan struct{})}
	done := a.abortCalled
	w := newThreadTestWorker(t, nil, a)
	clock := monotime.NewManual(time.Now())
	w.clock = clock
	threadMust(t, w.transaction(func(tx *sql.Tx) error {
		return w.stateReport(tx, "unknown", "thread.unknown", "消息发送状态不明")
	}))
	threadMust(t, w.StopThread(agent.EndStopped))
	<-done
	if err := w.EnqueueThreadMessage(context.Background(), "new", "body", "queue", ""); err == nil {
		t.Fatal("accepted message during unknown stop")
	}
	clock.Suspend(2 * time.Second)
	threadMust(t, w.Poll(context.Background()))
	if threadState(t, w) != "stopped" || a.kills != 1 {
		t.Fatal("unknown Agent was not stopped")
	}
	count := len(threadReports(t, w))
	threadMust(t, w.Poll(context.Background()))
	if len(threadReports(t, w)) != count {
		t.Fatal("repeated forced stop reports without active turn")
	}
}

func TestThreadExitedDuringStopRetainsTimeoutReason(t *testing.T) {
	a := &threadFake{resume: true, abortCalled: make(chan struct{})}
	done := a.abortCalled
	w := newThreadTestWorker(t, nil, a)
	threadMessage(t, w, "first", "queue")
	threadMust(t, w.StopThread(agent.EndTimeout))
	<-done
	a.add(agent.Event{Kind: agent.EventExited, Reason: "process exited"})
	threadMust(t, w.Poll(context.Background()))
	reports := threadReports(t, w)
	if reports[len(reports)-2].Kind != "turn.ended" || reports[len(reports)-2].Reason != agent.EndTimeout {
		t.Fatalf("reports=%+v", reports)
	}
}

func TestThreadIPCAndHostMethods(t *testing.T) {
	a := &threadFake{resume: true, switchModel: true}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.Model = "initial" }, a)
	token, err := EnsureToken(w.dataDir, w.options.ThreadID)
	threadMust(t, err)
	endpoint, err := Endpoint(w.dataDir, w.options.ThreadID)
	threadMust(t, err)
	ln, err := listenEndpoint(endpoint)
	threadMust(t, err)
	defer ln.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveThreadConn(ctx, conn, token, w)
		}
	}()
	h := &Host{DataDir: w.dataDir}
	threadMust(t, h.OpenThread(ctx, w.options))
	threadMust(t, h.ThreadMessage(ctx, w.options.ThreadID, "first", "body", "queue", "replacement"))
	threadMust(t, h.ThreadMessage(ctx, w.options.ThreadID, "queued", "next", "queue", "later"))
	if !reflect.DeepEqual(a.models, []string{"replacement"}) || threadModel(t, w) != "replacement" {
		t.Fatalf("IPC model lost or applied before turn: sends=%v current=%s", a.models, threadModel(t, w))
	}
	threadMust(t, h.ThreadWithdraw(ctx, w.options.ThreadID, "queued"))
	reports, err := h.ThreadPending(ctx, w.options.ThreadID, 0)
	threadMust(t, err)
	threadMust(t, h.ThreadAck(ctx, w.options.ThreadID, reports[0].EventID, reports[0].WorkerSeq))
	result, err := h.BrowserRequest(ctx, protocol.SessionRequest{Type: protocol.BodySessionRequest, OperationID: mustSessionID(t), SessionID: w.options.ThreadID, Action: "output"})
	threadMust(t, err)
	if !result.OK || result.State != "running" {
		t.Fatalf("result=%+v", result)
	}
	threadMust(t, h.ThreadStop(ctx, w.options.ThreadID, agent.EndStopped))
	conn, err := dialEndpoint(ctx, endpoint)
	if err == nil {
		defer conn.Close()
		if _, err := io.WriteString(conn, "{\"type\":\"auth\",\"token\":\"bad\"}\n"); err != nil {
			t.Fatal(err)
		}
		var reply ipcMessage
		threadMust(t, json.NewDecoder(conn).Decode(&reply))
		if reply.OK {
			t.Fatal("accepted invalid token")
		}
	}
}
