package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent/codex/codexreplaytest"
	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

func TestCodexWorkerEarlyInterrupt(t *testing.T) {
	binary := codexreplaytest.Build(t, "../../tools/agent-replay")
	for _, variant := range []string{"after_error", "retry_error", "completed_before_started", "recorded"} {
		t.Run(variant, func(t *testing.T) {
			tape := codexreplaytest.RecordedEarlyInterrupt(t, "../agent/codex/testdata/replay")
			if variant != "recorded" {
				tape = codexreplaytest.EarlyInterrupt(t, "../agent/codex/testdata/replay", variant)
			}
			work, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			home := t.TempDir()
			f := codexreplaytest.New(t, binary, work, home, tape, "event:turn/started", "event:turn/completed", "process:done")
			t.Setenv("BATON_AGENT_DRIVER", "native")
			t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
			t.Setenv("BATON_CODEX_BINARY", f.Binary)
			t.Setenv("BATON_CODEX_HOME", home)
			t.Setenv("BATON_CODEX_MODEL", tape.Header.Model)
			data, sid := t.TempDir(), mustSessionID(t)
			if _, err := EnsureToken(data, sid); err != nil {
				t.Fatal(err)
			}
			path, _ := LedgerPath(data, sid)
			if err := CreateLedger(path); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- RunWorker(ctx, data, sid) }()
			ep, _ := Endpoint(data, sid)
			token, _ := readToken(data, sid)
			c := waitClient(t, ep, token)
			_ = c.conn.SetDeadline(time.Time{})
			defer func() {
				_ = c.Close()
				cancel()
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(10 * time.Second):
					t.Error("Worker 未停止")
				}
			}()
			tid, eid := mustSessionID(t), mustSessionID(t)
			if _, err := c.Bind(tid, eid, "codex"); err != nil {
				t.Fatal(err)
			}
			nonce := armNonce(t, c, tid, eid)
			pub, priv, _ := ed25519.GenerateKey(rand.Reader)
			generation := mustSessionID(t)
			queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
			permit := signPermit(t, priv, tid, eid, generation, nonce, queue, startpermit.PermitTTL)
			if _, err := c.Authorize(tid, eid, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			payload, _ := task.MarshalExecutorInput("early interrupt", nil, nil, &work, nil, 1, nil)
			if _, err := c.SubmitInput(string(payload)); err != nil {
				f.Check(t)
				t.Fatal(err)
			}
			if _, err := c.Stop(task.StatusCancelled); err != nil {
				t.Fatal(err)
			}
			pending := func() Status {
				t.Helper()
				st, err := c.Pending()
				if err != nil {
					t.Fatal(err)
				}
				for _, r := range st.Reports {
					if r.Kind == protocol.ReportResult {
						var body protocol.ExecutionReport
						if err := json.Unmarshal(r.Body, &body); err != nil {
							t.Fatal(err)
						}
						if body.Status == task.StatusCompleted {
							t.Fatal("取消任务被交付为 completed")
						}
					}
				}
				return st
			}
			first := findStopReports(t, pending().Reports)
			if first.AgentStopped || first.OutcomeKnown || first.Status != task.StatusNeedsVerification {
				t.Fatalf("早到中止凭空确认停止: %+v", first)
			}
			if _, err := c.Ack(first.EventID); err != nil {
				t.Fatal(err)
			}
			if variant != "completed_before_started" {
				f.Wait(t, "event:turn/started")
				f.Release(t, "event:turn/started")
			}
			f.Wait(t, "event:turn/completed")
			f.Release(t, "event:turn/completed")
			if variant == "completed_before_started" {
				f.Wait(t, "event:turn/started")
				f.Release(t, "event:turn/started")
			}
			deadline := time.Now().Add(10 * time.Second)
			confirmed := false
			for time.Now().Before(deadline) {
				for _, r := range pending().Reports {
					if r.Kind != task.EventStopReport {
						continue
					}
					var body protocol.ExecutionReport
					if err := json.Unmarshal(r.Body, &body); err != nil {
						t.Fatal(err)
					}
					if body.AgentStopped {
						if body.OutcomeKnown || body.Status != task.StatusNeedsVerification || body.EventID == first.EventID {
							t.Fatalf("停止补报: %+v", body)
						}
						confirmed = true
					}
				}
				if confirmed {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !confirmed {
				f.Check(t)
				t.Fatal("未补报停止事实")
			}
			if _, _, err := c.NativeHistory(""); err != nil {
				f.Check(t)
				t.Fatal(err)
			}
			f.Wait(t, "process:done")
			pending()
		})
	}
}
