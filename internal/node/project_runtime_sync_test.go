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

func TestProjectRuntimeCleanupWaitsForSyncOnEveryConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	ledger := openTestLedger(t)
	manager, err := newProjectRuntimeManager(ctx, ledger)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.close()
	type syncConnection struct {
		round     int32
		ws        *websocket.Conn
		messageID string
	}
	type request struct {
		round int32
		body  protocol.ProjectRuntimeRequest
	}
	syncs := make(chan syncConnection, 2)
	requests := make(chan request, 8)
	failures := make(chan error, 2)
	var connections atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			failures <- err
			return
		}
		defer ws.CloseNow()
		round := connections.Add(1)
		if _, _, err := ws.Read(ctx); err != nil {
			failures <- err
			return
		}
		auth, _ := json.Marshal(protocol.Frame{Kind: protocol.KindAuthResult, OK: true})
		if err := ws.Write(ctx, websocket.MessageText, auth); err != nil {
			failures <- err
			return
		}
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var frame struct {
				Kind     string            `json:"kind"`
				Envelope protocol.Envelope `json:"envelope"`
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				failures <- err
				return
			}
			if frame.Kind != protocol.KindEnvelope {
				continue
			}
			var head struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(frame.Envelope.Body, &head); err != nil {
				failures <- err
				return
			}
			if head.Type == "node.sync" {
				select {
				case syncs <- syncConnection{round, ws, frame.Envelope.MessageID}:
				case <-ctx.Done():
				}
				continue
			}
			if head.Type != protocol.BodyProjectRuntimeRequest {
				continue
			}
			var body protocol.ProjectRuntimeRequest
			if err := json.Unmarshal(frame.Envelope.Body, &body); err != nil {
				failures <- err
				return
			}
			select {
			case requests <- request{round, body}:
			case <-ctx.Done():
				return
			}
			result, _ := json.Marshal(protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true})
			env := protocol.Envelope{CorrelationID: frame.Envelope.MessageID, Source: &protocol.Source{Kind: protocol.SourceControl}, Body: result}
			reply, _ := json.Marshal(map[string]any{"kind": protocol.KindEnvelope, "envelope": env})
			if err := ws.Write(ctx, websocket.MessageText, reply); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	opts := RunOptions{RelayURL: "wss" + strings.TrimPrefix(server.URL, "https"), Identity: sampleIdentity(t), Heartbeat: time.Second, RootCAs: roots, Logger: slog.New(slog.DiscardHandler), DataDir: ledger.dir, reportSender: &runtimeReportSender{}, projectRuntime: manager}
	for round := int32(1); round <= 2; round++ {
		runID := threadUUID(t)
		if _, err := ledger.db.Exec(`INSERT INTO project_runtime_runs(run_id,lease_epoch,state,cleanup_complete) VALUES(?,1,'exited',1)`, runID); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- runOnce(ctx, opts, "incarnation", ledger, nil) }()
		var connection syncConnection
		select {
		case connection = <-syncs:
			if connection.round != round {
				t.Fatal("unexpected connection", connection.round)
			}
		case err := <-failures:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		manager.signalCleanup()
		select {
		case req := <-requests:
			t.Fatalf("同步前发送了Runtime请求：%+v", req)
		case err := <-failures:
			t.Fatal(err)
		case <-time.After(300 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		manager.mu.Lock()
		available := manager.loop != nil
		manager.mu.Unlock()
		if available {
			t.Fatal("同步前开放了Runtime RPC")
		}
		var attempts int
		if err := ledger.db.QueryRow(`SELECT cleanup_attempts FROM project_runtime_runs WHERE run_id=?`, runID).Scan(&attempts); err != nil || attempts != 0 {
			t.Fatal("同步前领取了清理回执", attempts, err)
		}
		if result := manager.call(ctx, protocol.ProjectRuntimeRequest{RunID: runID, LeaseEpoch: 1, Operation: "renew"}); result.OK || result.Code != "unavailable" {
			t.Fatal("同步前Runtime调用未被拒绝", result)
		}
		ack := protocol.Envelope{CorrelationID: connection.messageID, Source: &protocol.Source{Kind: protocol.SourceControl}, Body: json.RawMessage(`{"type":"node.sync_result","ok":true}`)}
		raw, _ := json.Marshal(map[string]any{"kind": protocol.KindEnvelope, "envelope": ack})
		if err := connection.ws.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatal(err)
		}
		for _, operation := range []string{"exited", "stopped"} {
			select {
			case req := <-requests:
				if req.round != round || req.body.RunID != runID || req.body.Operation != operation {
					t.Fatalf("同步后清理请求不正确：%+v", req)
				}
			case err := <-failures:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
		awaitReceiptCondition(t, func() bool {
			var acked int
			return ledger.db.QueryRow(`SELECT cleanup_acked FROM project_runtime_runs WHERE run_id=?`, runID).Scan(&acked) == nil && acked == 1
		})
		connection.ws.CloseNow()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		manager.mu.Lock()
		available = manager.loop != nil
		capability := manager.controlReceipts
		manager.mu.Unlock()
		if available || capability {
			t.Fatal("断线后保留了旧RPC或连接能力")
		}
	}
}
