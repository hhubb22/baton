package session

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent/codex"
	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

func TestCodexWorkerInputHistoryAndRecovery(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex-fixture.exe")
	cmd := exec.Command("go", "test", "-c", "-o", binary, "../agent/codex")
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v %s", err, raw)
	}
	for _, mode := range []string{"complete", "running"} {
		t.Run(mode, func(t *testing.T) {
			work := t.TempDir()
			raw, err := os.ReadFile("../agent/codex/testdata/replay.json")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(work, "replay.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(work, "codex-fixture-mode"), []byte(mode), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("BATON_CODEX_BINARY", binary)
			t.Setenv("BATON_CODEX_HOME", work)
			t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
			data := t.TempDir()
			sid := mustSessionID(t)
			if _, err := EnsureToken(data, sid); err != nil {
				t.Fatal(err)
			}
			path, _ := LedgerPath(data, sid)
			if err := CreateLedger(path); err != nil {
				t.Fatal(err)
			}
			launch := func() (*Client, func()) {
				ctx, cancel := context.WithCancel(context.Background())
				done := make(chan error, 1)
				go func() { done <- RunWorker(ctx, data, sid) }()
				ep, _ := Endpoint(data, sid)
				token, _ := readToken(data, sid)
				c := waitClient(t, ep, token)
				stop := func() {
					_ = c.Close()
					cancel()
					select {
					case err := <-done:
						if err != nil {
							t.Error(err)
						}
					case <-time.After(10 * time.Second):
						t.Error("Worker failed to stop")
					}
				}
				return c, stop
			}
			c, stop := launch()
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
			payload, _ := task.MarshalExecutorInput("fixture task", nil, nil, &work, nil, 1, nil)
			if _, err := c.SubmitInput(string(payload)); err != nil {
				t.Fatal(err)
			}
			if _, err := c.SubmitInput(string(payload)); err != nil {
				t.Fatal(err)
			}
			waitReport := func(c *Client, kind string) protocol.ExecutionReport {
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					st, err := c.Pending()
					if err != nil {
						t.Fatal(err)
					}
					for _, r := range st.Reports {
						if r.Kind == kind {
							var report protocol.ExecutionReport
							if err := json.Unmarshal(r.Body, &report); err != nil {
								t.Fatal(err)
							}
							return report
						}
					}
					time.Sleep(20 * time.Millisecond)
				}
				t.Fatalf("missing %s", kind)
				return protocol.ExecutionReport{}
			}
			if mode == "complete" {
				if r := waitReport(c, protocol.ReportResult); r.Status != task.StatusCompleted || r.TaskID != tid || r.ExecutionID != eid || r.SessionID != sid {
					t.Fatal("untrusted result binding", r)
				}
			} else {
				if _, err := c.Stop(task.StatusCancelled); err != nil {
					t.Fatal(err)
				}
				if r := waitReport(c, task.EventStopReport); r.AgentStopped || r.OutcomeKnown {
					t.Fatal("interrupt ACK marked as stopped")
				} else if _, err := c.Ack(r.EventID); err != nil {
					t.Fatal(err)
				}
			}
			if history, _, err := c.NativeHistory(""); err != nil || !json.Valid(history) {
				t.Fatal("native history", err)
			}
			stop()
			c, stop = launch()
			defer stop()
			if mode == "complete" {
				waitReport(c, protocol.ReportResult)
			} else {
				if r := waitReport(c, task.EventStopReport); !r.AgentStopped || r.OutcomeKnown || r.Status != task.StatusNeedsVerification {
					t.Fatal("lost late stop fact or assumed side effects undone", r)
				}
			}
			requests, err := os.ReadFile(filepath.Join(work, "requests.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			for _, method := range []string{"thread/start", "turn/start"} {
				if n := strings.Count(string(requests), `"method":"`+method+`"`); n != 1 {
					t.Fatalf("%s replayed %d times", method, n)
				}
			}
			stateDir, _ := SessionDir(data, sid)
			stateRaw, err := os.ReadFile(filepath.Join(stateDir, "native", "state.json"))
			if err != nil {
				t.Fatal(err)
			}
			var s codex.State
			if json.Unmarshal(stateRaw, &s) != nil || s.ThreadID != "thread-fixture" {
				t.Fatal("native mapping replaced")
			}
		})
	}
}
