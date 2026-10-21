package node

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/protocol"

	"github.com/coder/websocket"
)

func TestThreadWireSyncReconnectAndReceipts(t *testing.T) {
	s, h, open := threadTestService(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	openID := threadUUID(t)
	if got, err := s.command(ctx, openID, open); err != nil || !got.OK {
		t.Fatal(got, err)
	}
	h.mu.Lock()
	h.append(open.ThreadID, "reply", "")
	h.mu.Unlock()
	messageID := threadUUID(t)
	message := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: open.ThreadID, Action: "message", StorageGeneration: s.ledger.Generation(), ClientMessageID: threadUUID(t), Content: "继续"}
	var connections atomic.Int32
	completed := make(chan error, 2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			completed <- err
			return
		}
		defer ws.CloseNow()
		round := connections.Add(1)
		read := func() (protocol.Envelope, string, error) {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return protocol.Envelope{}, "", err
			}
			var frame struct {
				Kind     string            `json:"kind"`
				Envelope protocol.Envelope `json:"envelope"`
			}
			err = json.Unmarshal(raw, &frame)
			return frame.Envelope, frame.Kind, err
		}
		write := func(env protocol.Envelope) error {
			raw, err := json.Marshal(map[string]any{"kind": protocol.KindEnvelope, "envelope": env})
			if err != nil {
				return err
			}
			return ws.Write(ctx, websocket.MessageText, raw)
		}
		if _, kind, err := read(); err != nil || kind != protocol.KindAuth {
			completed <- err
			return
		}
		auth, _ := json.Marshal(map[string]any{"kind": protocol.KindAuthResult, "ok": true})
		if err := ws.Write(ctx, websocket.MessageText, auth); err != nil {
			completed <- err
			return
		}
		sync, kind, err := read()
		if err != nil || kind != protocol.KindEnvelope {
			completed <- err
			return
		}
		// 同步确认前只有心跳，Thread 报告必须等待 node.sync_result。
		if _, kind, err := read(); err != nil || kind != protocol.KindHeartbeat {
			completed <- errorsForWire("同步前发送了 Thread 报告", err)
			return
		}
		if err := write(protocol.Envelope{CorrelationID: sync.MessageID, Body: json.RawMessage(`{"type":"node.sync_result","ok":true}`)}); err != nil {
			completed <- err
			return
		}
		body, _ := json.Marshal(message)
		var extended map[string]any
		_ = json.Unmarshal(body, &extended)
		extended["future_field"] = true
		body, _ = json.Marshal(extended)
		command := protocol.Envelope{MessageID: messageID, Source: &protocol.Source{Kind: protocol.SourceControl}, Body: body}
		if err := write(command); err != nil {
			completed <- err
			return
		}
		receipt := false
		seen := map[int64]bool{}
		lastSeq := int64(0)
		for !receipt || len(seen) < 2 {
			env, kind, err := read()
			if err != nil {
				completed <- err
				return
			}
			if kind != protocol.KindEnvelope {
				continue
			}
			var head struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(env.Body, &head)
			switch head.Type {
			case protocol.BodyThreadCommandResult:
				var result protocol.ThreadCommandResult
				_ = json.Unmarshal(env.Body, &result)
				if !result.OK || result.ThreadID != open.ThreadID || env.CorrelationID != messageID {
					completed <- errorsForWire("命令回执关联错误", nil)
					return
				}
				receipt = true
			case protocol.BodyThreadReport:
				var report protocol.ThreadReport
				_ = json.Unmarshal(env.Body, &report)
				if report.WorkerSeq < lastSeq && !seen[report.WorkerSeq] {
					completed <- errorsForWire("报告顺序错误", nil)
					return
				}
				lastSeq = report.WorkerSeq
				seen[report.WorkerSeq] = true
				if report.Kind == "thread.opened" && report.StorageGeneration != s.ledger.Generation() {
					completed <- errorsForWire("opened 缺少代次", nil)
					return
				}
				if round == 2 {
					ack, _ := json.Marshal(protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: report.ThreadID, EventID: report.EventID, WorkerSeq: report.WorkerSeq, OK: true})
					if err := write(protocol.Envelope{Source: &protocol.Source{Kind: protocol.SourceControl}, Body: ack, CorrelationID: env.MessageID}); err != nil {
						completed <- err
						return
					}
				}
			}
		}
		if round == 2 {
			deadline := time.NewTicker(5 * time.Millisecond)
			defer deadline.Stop()
			for h.count("ack") < 2 {
				select {
				case <-ctx.Done():
					completed <- ctx.Err()
					return
				case <-deadline.C:
				}
			}
		}
		completed <- nil
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	opts := RunOptions{RelayURL: "wss" + strings.TrimPrefix(server.URL, "https"), Identity: sampleIdentity(t), Heartbeat: 100 * time.Millisecond, RootCAs: roots, Logger: slog.New(slog.DiscardHandler), DataDir: s.ledger.dir, ThreadHost: h, reportSender: &runtimeReportSender{}}
	for i := 0; i < 2; i++ {
		_ = runOnce(ctx, opts, threadUUID(t), s.ledger, nil)
		select {
		case err := <-completed:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if h.count("open") != 1 || h.count("message") != 1 || h.count("ack") != 2 {
		t.Fatalf("重连或回执去重失败：open=%d message=%d ack=%d", h.count("open"), h.count("message"), h.count("ack"))
	}
}

func errorsForWire(message string, err error) error {
	if err != nil {
		return err
	}
	return &ValidationError{Message: message}
}

func TestThreadEnvelopeRejectsWrongSourceAndBoundsInbox(t *testing.T) {
	s, _, cmd := threadTestService(t)
	raw, _ := json.Marshal(cmd)
	if !s.handle(protocol.Envelope{MessageID: threadUUID(t), Body: raw}) {
		t.Fatal("未识别 Thread 命令")
	}
	if len(s.inbox) != 0 {
		t.Fatal("接受了非控制面命令")
	}
	for i := 0; i < 1000; i++ {
		s.handle(protocol.Envelope{MessageID: threadUUID(t), Source: &protocol.Source{Kind: protocol.SourceControl}, Body: raw})
	}
	if len(s.inbox) != cap(s.inbox) || cap(s.inbox) != 64 {
		t.Fatal("命令入口无界")
	}
}
