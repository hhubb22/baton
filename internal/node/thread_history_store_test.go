package node_test

import (
	"context"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/store"
	"github.com/coder/websocket"
)

type lostHistoryHost struct{ failure error }

func (h lostHistoryHost) OpenThread(context.Context, node.ThreadRecord) error {
	return errors.New("unexpected open")
}
func (h lostHistoryHost) ThreadMessage(context.Context, string, protocol.ThreadCommand) error {
	return errors.New("unexpected message")
}
func (h lostHistoryHost) ThreadWithdraw(context.Context, string, protocol.ThreadCommand) error {
	return errors.New("unexpected withdraw")
}
func (h lostHistoryHost) ThreadStop(context.Context, string, protocol.ThreadCommand) error {
	return errors.New("unexpected stop")
}
func (h lostHistoryHost) ThreadPending(context.Context, string, int64) ([]protocol.ThreadReport, error) {
	return nil, h.failure
}
func (h lostHistoryHost) ThreadAck(context.Context, string, string, int64) error {
	return errors.New("unexpected Worker ACK")
}
func (h lostHistoryHost) ThreadFailure(context.Context, string, string, string, string) error {
	return errors.New("unexpected Worker failure")
}

func TestNodeHistoryLossReportEndsStoreActiveTurn(t *testing.T) {
	for _, failure := range []struct {
		name   string
		err    error
		status string
	}{
		{"missing", session.ErrHistoryMissing, "stopped"},
		{"corrupt", session.ErrHistoryIncompatible, "stopped"},
	} {
		t.Run(failure.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			uuid := func() string {
				id, err := identity.NewUUID()
				if err != nil {
					t.Fatal(err)
				}
				return id
			}
			pool := dbtest.Open(t)
			repo := store.New(pool)
			employee, err := admin.CreateLocal(ctx, pool, "history-owner", "History Owner", "test-history-password-123")
			if err != nil {
				t.Fatal(err)
			}
			_, enrollment, _, err := repo.IssueEnrollment(ctx, employee.ID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			signer, err := node.GenerateSigner()
			if err != nil {
				t.Fatal(err)
			}
			ident, err := repo.Register(ctx, store.RegisterInput{Token: enrollment, DisplayName: "History Node", System: node.SystemLinux, Capabilities: []string{"pi"}, CredentialTTL: time.Hour}, signer)
			if err != nil {
				t.Fatal(err)
			}
			src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: employee.ID, NodeID: ident.NodeID, CredentialID: ident.Credential.ID, ConnID: uuid(), Incarnation: uuid()}
			if err := repo.ConnectNode(ctx, src); err != nil {
				t.Fatal(err)
			}
			if err := repo.SyncNode(ctx, employee.ID, ident.NodeID, src.ConnID, ident.DisplayName, ident.System, ident.Role, ident.Capabilities); err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			_, err = repo.SaveRuntimeReport(ctx, src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "work", Path: root}}, Agents: []protocol.RuntimeAgent{{AgentType: "pi", Version: "test", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Stop: true, Resume: true}}}})
			if err != nil {
				t.Fatal(err)
			}
			thread, _, err := repo.CreateThread(ctx, employee.ID, store.CreateThreadInput{ClientThreadID: uuid(), NodeID: ident.NodeID, AgentType: "pi", WorkingDirectory: root, Message: store.ThreadMessageInput{ClientMessageID: "first", Content: "start"}})
			if err != nil {
				t.Fatal(err)
			}
			data := t.TempDir()
			ledger, err := node.OpenLedger(data)
			if err != nil {
				t.Fatal(err)
			}
			generation := ledger.Generation()
			if err := ledger.Close(); err != nil {
				t.Fatal(err)
			}
			local, err := sql.Open("sqlite", filepath.Join(data, "node.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer local.Close()
			stamp := time.Now().UTC().Format(time.RFC3339Nano)
			_, err = local.Exec(`INSERT INTO threads(thread_id,session_id,storage_generation,agent_type,working_directory,execution_timeout_seconds,open_message_id,status,created_at,updated_at) VALUES(?,?,?,'pi',?,7200,?,'ready',?,?);
 INSERT INTO thread_report_progress(thread_id,worker_seq) VALUES(?,12)`, thread.ID, thread.ID, generation, root, uuid(), stamp, stamp, thread.ID)
			if err != nil {
				t.Fatal(err)
			}
			for i, kind := range []string{"thread.opened", "turn.started", "message.sent"} {
				report := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: thread.ID, EventID: uuid(), WorkerSeq: int64(i + 1), Kind: kind}
				if i == 0 {
					report.StorageGeneration = generation
				} else {
					report.WorkerTurnSeq = 1
					report.ClientMessageID = "first"
				}
				ack, err := repo.SaveThreadReport(ctx, src, report)
				if err != nil || !ack.OK {
					t.Fatal(ack, err)
				}
			}
			delivered := make(chan protocol.ThreadReport, 1)
			failures := make(chan error, 1)
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := websocket.Accept(w, r, nil)
				if err != nil {
					failures <- err
					return
				}
				defer ws.CloseNow()
				if _, _, err := ws.Read(ctx); err != nil {
					failures <- err
					return
				}
				auth, _ := json.Marshal(protocol.Frame{Kind: protocol.KindAuthResult, OK: true})
				if err := ws.Write(ctx, websocket.MessageText, auth); err != nil {
					failures <- err
					return
				}
				send := func(correlation string, value any) error {
					body, err := json.Marshal(value)
					if err != nil {
						return err
					}
					raw, err := json.Marshal(map[string]any{"kind": protocol.KindEnvelope, "envelope": protocol.Envelope{Source: &protocol.Source{Kind: protocol.SourceControl}, CorrelationID: correlation, Body: body}})
					if err != nil {
						return err
					}
					return ws.Write(ctx, websocket.MessageText, raw)
				}
				var eventID string
				for {
					_, raw, err := ws.Read(ctx)
					if err != nil {
						return
					}
					var frame struct {
						Kind     string            `json:"kind"`
						Envelope protocol.Envelope `json:"envelope"`
					}
					if json.Unmarshal(raw, &frame) != nil || frame.Kind != protocol.KindEnvelope {
						continue
					}
					var head struct {
						Type string `json:"type"`
					}
					if json.Unmarshal(frame.Envelope.Body, &head) != nil {
						continue
					}
					if head.Type == "node.sync" {
						if err := send(frame.Envelope.MessageID, map[string]any{"type": "node.sync_result", "ok": true}); err != nil {
							failures <- err
							return
						}
						continue
					}
					if head.Type != protocol.BodyThreadReport {
						continue
					}
					var report protocol.ThreadReport
					if err := json.Unmarshal(frame.Envelope.Body, &report); err != nil {
						failures <- err
						return
					}
					if !report.HistoryUnavailable || report.WorkerTurnSeq != 0 {
						failures <- fmt.Errorf("invalid node recovery report: %+v", report)
						return
					}
					if eventID != "" && eventID != report.EventID {
						failures <- errors.New("sequence repair changed report identity")
						return
					}
					eventID = report.EventID
					ack, err := repo.SaveThreadReport(ctx, src, report)
					if err != nil {
						failures <- err
						return
					}
					if !ack.OK && (ack.Code != "worker_sequence_gap" || ack.ExpectedWorkerSeq != 4) {
						failures <- fmt.Errorf("unexpected recovery rejection: %+v", ack)
						return
					}
					if ack.OK {
						duplicate, err := repo.SaveThreadReport(ctx, src, report)
						if err != nil || duplicate != ack {
							failures <- fmt.Errorf("repeated node recovery changed ACK: %v", err)
							return
						}
					}
					if err := send(frame.Envelope.MessageID, ack); err != nil {
						failures <- err
						return
					}
					if ack.OK {
						delivered <- report
						return
					}
				}
			}))
			defer server.Close()
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			done := make(chan error, 1)
			go func() {
				done <- node.Maintain(ctx, node.RunOptions{RelayURL: "wss" + strings.TrimPrefix(server.URL, "https"), Identity: ident, Heartbeat: 100 * time.Millisecond, RootCAs: roots, DataDir: data, ThreadHost: lostHistoryHost{failure.err}, DiscoverRuntimeModels: func(context.Context, string, string) ([]protocol.RuntimeModel, string, error) {
					return nil, "", errors.New("model probe disabled")
				}, ProbeRuntimeAgentVersion: func(context.Context, string) (string, error) { return "", errors.New("version probe disabled") }})
			}()
			defer func() { cancel(); <-done }()
			var report protocol.ThreadReport
			select {
			case report = <-delivered:
			case err := <-failures:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			view, err := repo.GetThread(ctx, employee.ID, thread.ID)
			if err != nil || view.Status != failure.status || view.LastWorkerSeq != 4 || report.WorkerSeq != 4 {
				t.Fatal(view, report, err)
			}
			var active, ended, recoveryAudits int
			err = pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL),
 (SELECT count(*) FROM thread_turns WHERE thread_id=$1 AND end_reason='agent_exited'),
 (SELECT count(*) FROM thread_events WHERE thread_id=$1 AND kind='turn.ended')`, thread.ID).Scan(&active, &ended, &recoveryAudits)
			if err != nil || active != 0 || ended != 1 || recoveryAudits != 1 {
				t.Fatal(active, ended, recoveryAudits, err)
			}
		})
	}
}
