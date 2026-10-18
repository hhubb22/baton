package node

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"

	"github.com/coder/websocket"
)

func TestPersistentHistoryReadFailureIsBounded(t *testing.T) {
	led := openTestLedger(t)
	in := samplePrepare(t)
	prepared := led.Prepare(in, nil)
	if !prepared.OK {
		t.Fatalf("准备失败: %+v", prepared)
	}
	if err := led.RememberWorker(prepared.SessionID, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	path, err := session.LedgerPath(led.dir, prepared.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.CreateLedger(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	if f, err := os.Open(path); err == nil {
		f.Close()
		t.Skip("当前用户仍能读取无权限文件")
	}
	var logs bytes.Buffer
	loop, reports := historyTestLoop(t, led, &logs, true)
	for i := 1; i < historyReadFailureLimit; i++ {
		loop.resendPending(context.Background())
		if len(reports) != 0 {
			t.Fatal("阈值前上报了待核实")
		}
	}
	// 重开节点账本、重建连接循环不能清空已经累计的失败。
	if err := led.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenLedger(led.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	loop, reports = historyTestLoop(t, reopened, &logs, true)
	loop.resendPending(context.Background())
	first := historyReport(t, reports)
	if first.ErrorCode != task.CodeUncertainHistory || first.Status != task.StatusNeedsVerification ||
		first.Kind != protocol.ReportNeedsVerification || first.TaskID != in.TaskID ||
		first.ExecutionID != in.ExecutionID || first.SessionID != prepared.SessionID {
		t.Fatalf("待核实报告不正确: %+v", first)
	}
	// 首次 ACK 失败后只补报相同事件，不再读取账本或拉起 Worker。
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	loop.resendPending(context.Background())
	second := historyReport(t, reports)
	if first.EventID != second.EventID {
		t.Fatal("补报改变了事件标识")
	}
	for i := 0; i < 5; i++ {
		loop.resendPending(context.Background())
	}
	if len(reports) != 0 || strings.Count(logs.String(), "event=history_read_failed") != historyReadFailureLimit ||
		strings.Contains(logs.String(), "event=worker_missing") || strings.Contains(logs.String(), "event=history_unreadable") {
		t.Fatalf("阈值后仍在重试读取或启动 Worker: %s", logs.String())
	}
	if n, err := reopened.historyReadFailures(prepared.SessionID); err != nil || n != historyReadFailureLimit {
		t.Fatalf("失败阈值没有保留: %d %v", n, err)
	}
	if receipts(t, reopened) != 1 {
		t.Fatal("读取失败产生了新执行")
	}
}

func TestTransientHistoryReadFailureResetsAfterSuccessfulRead(t *testing.T) {
	led := openTestLedger(t)
	prepared := led.Prepare(samplePrepare(t), nil)
	if !prepared.OK {
		t.Fatalf("准备失败: %+v", prepared)
	}
	if err := led.RememberWorker(prepared.SessionID, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	path, err := session.LedgerPath(led.dir, prepared.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.CreateLedger(path); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`INSERT INTO meta (key, value) VALUES ('result_delivered', '1')`); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	loop, reports := historyTestLoop(t, led, &logs, false)
	if _, err := db.Exec(`PRAGMA journal_mode=DELETE`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`BEGIN EXCLUSIVE`); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(`ROLLBACK`)
	loop.resendPending(context.Background())
	if n, err := led.historyReadFailures(prepared.SessionID); err != nil || n != 1 || len(reports) != 0 {
		t.Fatalf("独占锁没有留待心跳重试: failures %d reports %d err %v", n, len(reports), err)
	}
	if _, err := db.Exec(`ROLLBACK`); err != nil {
		t.Fatal(err)
	}
	loop.resendPending(context.Background())
	for i := 0; i < historyReadFailureLimit+1; i++ {
		if !loop.historyReadFailed(context.Background(), prepared.SessionID, fmt.Errorf("busy: %w", session.ErrHistoryUnread)) {
			t.Fatal("暂时读取失败没有被处理")
		}
		loop.resendPending(context.Background())
		if n, err := led.historyReadFailures(prepared.SessionID); err != nil || n != 0 {
			t.Fatalf("成功读取后没有清空连续失败: %d %v", n, err)
		}
	}
	if len(reports) != 0 || strings.Contains(logs.String(), "event=history_unreadable") ||
		strings.Count(logs.String(), "event=history_read_failed") != historyReadFailureLimit+2 {
		t.Fatalf("短暂错误被当成损坏或待核实: %s", logs.String())
	}
}

func TestHistoryReadFailureCountIsAtomicAndSessionScoped(t *testing.T) {
	led := openTestLedger(t)
	id := mustID(t)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Go(func() {
			if _, err := led.recordHistoryReadFailure(id); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n, err := led.historyReadFailures(id); err != nil || n != historyReadFailureLimit {
		t.Fatalf("并发计数没有饱和在阈值: %d %v", n, err)
	}
	if n, err := led.historyReadFailures(mustID(t)); err != nil || n != 0 {
		t.Fatalf("一个 Session 的失败影响了其他 Session: %d %v", n, err)
	}
}

func historyTestLoop(t *testing.T, led *Ledger, logs *bytes.Buffer, failFirst bool) (*startLoop, <-chan protocol.ExecutionReport) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	reports := make(chan protocol.ExecutionReport, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for n := 0; ; n++ {
			_, raw, err := ws.Read(r.Context())
			if err != nil {
				return
			}
			var frame struct {
				Envelope protocol.Envelope `json:"envelope"`
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Error(err)
				return
			}
			var report protocol.ExecutionReport
			if err := json.Unmarshal(frame.Envelope.Body, &report); err != nil {
				t.Error(err)
				return
			}
			reports <- report
			ack := protocol.ReportAck{Type: protocol.BodyExecutionReportResult, OK: !failFirst || n > 0}
			if !ack.OK {
				ack.Code = "unavailable"
			}
			body, _ := json.Marshal(ack)
			reply, _ := json.Marshal(protocol.Envelope{CorrelationID: frame.Envelope.MessageID, Body: body})
			if err := ws.Write(r.Context(), websocket.MessageText, reply); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	loop := newStartLoop(ctx, Identity{}, led, &session.Host{DataDir: led.dir}, newWSWriter(ws), slog.New(slog.NewTextHandler(logs, nil)))
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Error(err)
				return
			}
			loop.onReply(env)
		}
	}()
	t.Cleanup(func() {
		_ = ws.CloseNow()
		<-done
	})
	return loop, reports
}

func historyReport(t *testing.T, reports <-chan protocol.ExecutionReport) protocol.ExecutionReport {
	t.Helper()
	select {
	case report := <-reports:
		return report
	case <-time.After(2 * time.Second):
		t.Fatal("没有收到历史待核实报告")
		return protocol.ExecutionReport{}
	}
}
