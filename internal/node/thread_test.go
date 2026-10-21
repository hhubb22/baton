package node

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"

	"baton/internal/identity"
	"baton/internal/protocol"
)

type threadTestHost struct {
	mu       sync.Mutex
	ledger   *Ledger
	calls    map[string]int
	commands map[string]bool
	reports  map[string][]protocol.ThreadReport
	acked    map[string]bool
	fail     error
}

func newThreadTestHost(l *Ledger) *threadTestHost {
	return &threadTestHost{ledger: l, calls: map[string]int{}, commands: map[string]bool{}, reports: map[string][]protocol.ThreadReport{}, acked: map[string]bool{}}
}
func threadUUID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func (h *threadTestHost) OpenThread(ctx context.Context, r ThreadRecord) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != nil {
		return h.fail
	}
	stored, err := h.ledger.Thread(ctx, r.ThreadID)
	if err != nil {
		return err
	}
	if stored.SessionID != r.SessionID || stored.StorageGeneration != r.StorageGeneration {
		return errors.New("Worker 调用早于映射持久化")
	}
	if h.commands["open:"+r.ThreadID] {
		return nil
	}
	h.commands["open:"+r.ThreadID] = true
	h.calls["open"]++
	h.append(r.ThreadID, "thread.opened", "")
	return nil
}
func (h *threadTestHost) append(id, kind, reason string) {
	seq := int64(len(h.reports[id]) + 1)
	event, _ := identity.NewUUID()
	h.reports[id] = append(h.reports[id], protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: event, WorkerSeq: seq, Kind: kind, Reason: reason})
}
func (h *threadTestHost) command(id, kind string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != nil {
		return h.fail
	}
	if !h.commands[id] {
		h.commands[id] = true
		h.calls[kind]++
	}
	return nil
}
func (h *threadTestHost) ThreadMessage(ctx context.Context, id string, cmd protocol.ThreadCommand) error {
	return h.command(id, "message")
}
func (h *threadTestHost) ThreadWithdraw(ctx context.Context, id string, cmd protocol.ThreadCommand) error {
	return h.command(id, "withdraw")
}
func (h *threadTestHost) ThreadStop(ctx context.Context, id string, cmd protocol.ThreadCommand) error {
	return h.command(id, "stop")
}
func (h *threadTestHost) ThreadFailure(ctx context.Context, id, threadID, kind, reason string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != nil {
		return h.fail
	}
	if !h.commands[id] {
		h.commands[id] = true
		h.calls["failure"]++
		h.append(threadID, kind, reason)
	}
	return nil
}
func (h *threadTestHost) ThreadPending(ctx context.Context, id string, from int64) ([]protocol.ThreadReport, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != nil {
		return nil, h.fail
	}
	var pending []protocol.ThreadReport
	for _, r := range h.reports[id] {
		if !h.acked[r.EventID] && r.WorkerSeq >= from {
			pending = append(pending, r)
		}
	}
	if len(pending) > 32 {
		pending = pending[:32]
	}
	// 转发层仍须按 WorkerSeq 排序。
	sort.Slice(pending, func(i, j int) bool { return pending[i].WorkerSeq > pending[j].WorkerSeq })
	return pending, nil
}
func (h *threadTestHost) ThreadAck(ctx context.Context, id, event string, seq int64) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.reports[id] {
		if r.EventID == event && r.WorkerSeq == seq {
			h.acked[event] = true
			h.calls["ack"]++
			return nil
		}
	}
	return errors.New("回执身份错误")
}
func (h *threadTestHost) count(kind string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls[kind]
}

func threadTestService(t *testing.T) (*threadService, *threadTestHost, protocol.ThreadCommand) {
	t.Helper()
	l := openTestLedger(t)
	root := t.TempDir()
	if err := AddBrowseRoot(l.dir, "work", root); err != nil {
		t.Fatal(err)
	}
	// shell 为内置 Agent，测试不依赖机器安装的模型 CLI。
	shell, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteProjectExec(l.dir, protocol.RuntimeExec{Enabled: true, Shell: shell}); err != nil {
		t.Fatal(err)
	}
	h := newThreadTestHost(l)
	s := newThreadService(l, h, 0, nil, func(context.Context, string, any) error { return nil })
	cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: threadUUID(t), Action: "open", AgentType: "shell", WorkingDirectory: root, ExecutionTimeoutSeconds: 20}
	return s, h, cmd
}

func TestThreadCommandsPersistAndDeduplicate(t *testing.T) {
	s, h, open := threadTestService(t)
	ctx := t.Context()
	id := threadUUID(t)
	for i := 0; i < 3; i++ {
		result, err := s.command(ctx, id, open)
		if err != nil || !result.OK {
			t.Fatalf("open: %+v %v", result, err)
		}
	}
	if h.count("open") != 1 {
		t.Fatal("重复 open 创建 Worker")
	}
	record, err := s.ledger.Thread(ctx, open.ThreadID)
	if err != nil {
		t.Fatal(err)
	}
	if record.SessionID != open.ThreadID || record.StorageGeneration != s.ledger.Generation() || record.OpenMessageID != id || record.Status != "ready" || record.CreatedAt == "" || record.UpdatedAt == "" {
		t.Fatalf("映射不完整：%+v", record)
	}
	// 新命令 ID 重复 open 仍返回原来的会话。
	if result, err := s.command(ctx, threadUUID(t), open); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	if h.count("open") != 1 {
		t.Fatal("open 映射未去重")
	}
	for _, action := range []string{"message", "withdraw", "stop"} {
		cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: open.ThreadID, Action: action, StorageGeneration: s.ledger.Generation(), ClientMessageID: threadUUID(t), Content: "继续", Mode: "queue"}
		id := threadUUID(t)
		for i := 0; i < 3; i++ {
			result, err := s.command(ctx, id, cmd)
			if err != nil || !result.OK {
				t.Fatalf("%s: %+v %v", action, result, err)
			}
		}
		if h.count(action) != 1 {
			t.Fatalf("%s 重复投递", action)
		}
	}
	// 命令身份不能被另一份正文复用。
	changed := open
	changed.WorkingDirectory = t.TempDir()
	if _, err := s.command(ctx, id, changed); err == nil {
		t.Fatal("命令 ID 正文冲突未被拒绝")
	}
}

func TestThreadGenerationMismatchNeverCreatesSession(t *testing.T) {
	for _, action := range []string{"message", "withdraw", "stop"} {
		for _, mode := range []string{"missing", "generation", "record_generation", "empty"} {
			t.Run(action+"/"+mode, func(t *testing.T) {
				s, h, open := threadTestService(t)
				ctx := t.Context()
				if mode != "missing" {
					if got, err := s.command(ctx, threadUUID(t), open); err != nil || !got.OK {
						t.Fatal(got, err)
					}
				}
				generation := s.ledger.Generation()
				if mode == "generation" {
					generation = threadUUID(t)
				}
				if mode == "empty" {
					generation = ""
				}
				if mode == "record_generation" {
					if _, err := s.ledger.db.Exec(`UPDATE threads SET storage_generation=?`, threadUUID(t)); err != nil {
						t.Fatal(err)
					}
				}
				cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, Action: action, ThreadID: open.ThreadID, StorageGeneration: generation, ClientMessageID: threadUUID(t), Content: "运行"}
				id := threadUUID(t)
				for i := 0; i < 2; i++ {
					got, err := s.command(ctx, id, cmd)
					if err != nil || !got.OK {
						t.Fatalf("回执：%+v %v", got, err)
					}
				}
				if h.count(action) != 0 {
					t.Fatal("代次不匹配仍向 Worker 转发")
				}
				if mode == "missing" {
					if _, err := s.ledger.Thread(ctx, open.ThreadID); !errors.Is(err, sql.ErrNoRows) {
						t.Fatal("缺失 Thread 被重建", err)
					}
				}
				reports, err := s.pending(ctx, open.ThreadID, 1)
				if err != nil {
					t.Fatal(err)
				}
				last := reports[len(reports)-1]
				if last.Kind != "thread.stopped" || last.Reason != "本地历史缺失" {
					t.Fatalf("失败报告：%+v", reports)
				}
				want := 1
				if mode != "missing" {
					want = 2
				}
				if len(reports) != want {
					t.Fatal("失败报告未去重", reports)
				}
			})
		}
	}
}

func TestThreadOpenFailuresAreDurable(t *testing.T) {
	for _, mode := range []string{"outside", "missing", "unsupported", "disabled", "host_unavailable", "binary_missing", "symlink_escape"} {
		t.Run(mode, func(t *testing.T) {
			s, h, cmd := threadTestService(t)
			switch mode {
			case "outside":
				cmd.WorkingDirectory = t.TempDir()
			case "missing":
				cmd.WorkingDirectory = filepath.Join(cmd.WorkingDirectory, "missing")
			case "unsupported":
				cmd.AgentType = "other"
			case "disabled":
				if err := WriteProjectExec(s.ledger.dir, protocol.RuntimeExec{Shell: DefaultProjectShell()}); err != nil {
					t.Fatal(err)
				}
			case "host_unavailable":
				s.host = nil
			case "binary_missing":
				t.Setenv("PATH", t.TempDir())
				cmd.AgentType = "codex"
				s.caps = []string{"codex"}
			case "symlink_escape":
				link := filepath.Join(cmd.WorkingDirectory, "outside")
				if err := os.Symlink(t.TempDir(), link); err != nil {
					t.Skip(err)
				}
				cmd.WorkingDirectory = link
			}
			id := threadUUID(t)
			for i := 0; i < 2; i++ {
				result, err := s.command(t.Context(), id, cmd)
				if err != nil || !result.OK {
					t.Fatalf("失败 open 仍应回接收确认：%+v %v", result, err)
				}
			}
			record, err := s.ledger.Thread(t.Context(), cmd.ThreadID)
			if err != nil || record.Status != "open_failed" {
				t.Fatal(record, err)
			}
			reports, err := s.ledger.nodeThreadPending(t.Context(), cmd.ThreadID, 1)
			if err != nil || len(reports) != 1 || reports[0].Kind != "thread.open_failed" || reports[0].Reason == "" {
				t.Fatalf("报告：%+v %v", reports, err)
			}
			if h.count("open") != 0 {
				t.Fatal("非法 open 启动了 Worker")
			}
			original := reports[0]
			dir := s.ledger.dir
			if err := s.ledger.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenLedger(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			s.ledger = reopened
			reports, err = s.pending(t.Context(), cmd.ThreadID, 1)
			if err != nil || len(reports) != 1 || !reflect.DeepEqual(reports[0], original) {
				t.Fatalf("重启丢失失败报告：%+v %v", reports, err)
			}
			ack := protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: original.ThreadID, EventID: original.EventID, WorkerSeq: original.WorkerSeq, OK: true}
			if err := s.reportResult(t.Context(), ack); err != nil {
				t.Fatal(err)
			}
			reports, err = s.pending(t.Context(), cmd.ThreadID, 1)
			if err != nil || len(reports) != 0 {
				t.Fatal("失败报告未确认", reports, err)
			}
		})
	}
}

func TestThreadReportsOrderedAndGapReplay(t *testing.T) {
	s, h, cmd := threadTestService(t)
	ctx := t.Context()
	if got, err := s.command(ctx, threadUUID(t), cmd); err != nil || !got.OK {
		t.Fatal(got, err)
	}
	h.mu.Lock()
	h.append(cmd.ThreadID, "turn.started", "")
	h.append(cmd.ThreadID, "reply", "")
	h.append(cmd.ThreadID, "turn.ended", "")
	h.mu.Unlock()
	var sent []protocol.ThreadReport
	s.send = func(ctx context.Context, correlation string, v any) error {
		sent = append(sent, v.(protocol.ThreadReport))
		return nil
	}
	if err := s.flush(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 4 {
		t.Fatal(sent)
	}
	for i, r := range sent {
		if r.WorkerSeq != int64(i+1) {
			t.Fatal("报告顺序错误", sent)
		}
	}
	if sent[0].StorageGeneration != s.ledger.Generation() {
		t.Fatal("opened 缺少存储代次")
	}
	last := sent[3]
	sent = nil
	gap := protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: cmd.ThreadID, EventID: last.EventID, WorkerSeq: last.WorkerSeq, Code: "worker_sequence_gap", ExpectedWorkerSeq: 2}
	if err := s.reportResult(ctx, gap); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 3 || sent[0].WorkerSeq != 2 || sent[2].EventID != last.EventID {
		t.Fatalf("缺口补报：%+v", sent)
	}
	gap.OK = true
	if err := s.reportResult(ctx, gap); err != nil {
		t.Fatal(err)
	}
	if h.count("ack") != 1 {
		t.Fatal("未转交 Worker 回执")
	}
	// 重复 ACK 与伪造事件不能确认另一条报告。
	if err := s.reportResult(ctx, gap); err != nil {
		t.Fatal(err)
	}
	gap.EventID = threadUUID(t)
	gap.WorkerSeq = 1
	if err := s.reportResult(ctx, gap); err != nil {
		t.Fatal(err)
	}
	if h.count("ack") != 1 {
		t.Fatal("错误或重复 ACK 进入 Worker")
	}
}

func TestThreadBudgetRejectsOnlyNewWork(t *testing.T) {
	s, h, cmd := threadTestService(t)
	ctx := t.Context()
	openID := threadUUID(t)
	if result, err := s.command(ctx, openID, cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	message := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: cmd.ThreadID, Action: "message", StorageGeneration: s.ledger.Generation(), ClientMessageID: threadUUID(t), Content: "运行"}
	messageID := threadUUID(t)
	if result, err := s.command(ctx, messageID, message); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	s.budget = 1
	// 已接收的请求重放不能被空间水位拒绝。
	for _, item := range []struct {
		id  string
		cmd protocol.ThreadCommand
	}{{openID, cmd}, {messageID, message}} {
		if result, err := s.command(ctx, item.id, item.cmd); err != nil || !result.OK {
			t.Fatal(result, err)
		}
	}
	other := cmd
	other.ThreadID = threadUUID(t)
	for _, item := range []protocol.ThreadCommand{other, message} {
		result, err := s.command(ctx, threadUUID(t), item)
		if err != nil || result.OK || result.Code != "storage_budget_exceeded" {
			t.Fatal(result, err)
		}
	}
	if _, err := s.ledger.Thread(ctx, other.ThreadID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("水位拒绝后仍创建映射", err)
	}
	for _, action := range []string{"withdraw", "stop"} {
		item := message
		item.Action = action
		if result, err := s.command(ctx, threadUUID(t), item); err != nil || !result.OK {
			t.Fatal(result, err)
		}
	}
	if h.count("message") != 1 {
		t.Fatal("水位之后仍投递新消息")
	}
}

func TestThreadHostPersistenceFailureRemainsRetryable(t *testing.T) {
	s, h, open := threadTestService(t)
	ctx := t.Context()
	if result, err := s.command(ctx, threadUUID(t), open); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	h.fail = errors.New("SQLite 写入失败")
	cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: open.ThreadID, Action: "message", StorageGeneration: s.ledger.Generation(), ClientMessageID: threadUUID(t), Content: "继续"}
	id := threadUUID(t)
	if _, err := s.command(ctx, id, cmd); err == nil {
		t.Fatal("持久化失败却确认了命令")
	}
	h.fail = nil
	if result, err := s.command(ctx, id, cmd); err != nil || !result.OK {
		t.Fatal("恢复后无法接收", result, err)
	}
	if h.count("message") != 1 {
		t.Fatal("持久化失败造成丢失或重复")
	}
}

func TestThreadCommandValidation(t *testing.T) {
	s, _, open := threadTestService(t)
	for _, mutate := range []func(*protocol.ThreadCommand){
		func(c *protocol.ThreadCommand) { c.ThreadID = "invalid" },
		func(c *protocol.ThreadCommand) { c.Action = "other" },
		func(c *protocol.ThreadCommand) {
			c.Action = "message"
			c.ClientMessageID = threadUUID(t)
			c.Content = "x"
			c.Mode = "other"
		},
		func(c *protocol.ThreadCommand) { c.Action = "withdraw"; c.ClientMessageID = "" },
		func(c *protocol.ThreadCommand) { c.ExecutionTimeoutSeconds = -1 },
	} {
		cmd := open
		mutate(&cmd)
		result, err := s.command(t.Context(), threadUUID(t), cmd)
		if err != nil || result.OK || result.Code != "invalid_command" {
			t.Fatal(result, err)
		}
	}
}
