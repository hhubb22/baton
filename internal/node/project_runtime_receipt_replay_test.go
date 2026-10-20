package node

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestProjectCleanupNaturalExitPersistsProofBeforeReceipts(t *testing.T) {
	t.Setenv("BATON_TEST_PROJECT_STDIO", "1")
	var manager *projectRuntimeManager
	m, requests, log := projectRuntimeFixture(t, func(req protocol.ProjectRuntimeRequest) {
		if req.Operation != "exited" && req.Operation != "stopped" {
			return
		}
		manager.mu.Lock()
		_, active := manager.runs[req.RunID]
		manager.mu.Unlock()
		var complete int
		err := manager.ledger.db.QueryRow(`SELECT cleanup_complete FROM project_runtime_runs WHERE run_id=?`, req.RunID).Scan(&complete)
		entries, dirErr := os.ReadDir(filepath.Join(manager.ledger.dir, "project-runtimes"))
		if active || err != nil || complete != 1 || dirErr != nil || len(entries) != 0 {
			t.Errorf("receipt preceded cleanup: active=%v complete=%d ledger=%v dirs=%v err=%v", active, complete, err, entries, dirErr)
		}
	})
	manager = m
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "exited")
	waitProjectRequest(t, requests, "stopped")
	awaitReceiptCondition(t, func() bool {
		var acked int
		_ = m.ledger.db.QueryRow(`SELECT cleanup_acked FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&acked)
		return acked == 1
	})
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "exited")
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if json.Unmarshal(raw, &record) != nil {
		t.Fatalf("run started more than once: %s", raw)
	}
}

func TestProjectWakeLostReplyRetriesSameIDsAndLaterInputs(t *testing.T) {
	m := receiptManager(t, "")
	var wakes atomic.Int32
	requests := receiptConnection(t, m, func(_ context.Context, req protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		if req.Operation == "wake_received" && wakes.Add(1) == 1 {
			return protocol.ProjectRuntimeResult{}, false
		}
		return protocol.ProjectRuntimeResult{OK: true, Data: json.RawMessage(`{"control_receipts":1}`)}, true
	})
	command := projectCommand()
	syntheticProjectProcess(m, command)
	m.report(command, "renew", "")
	command.Type, command.InputIDs = protocol.BodyProjectRunWake, []int64{20}
	sendProjectCommand(m, command)
	first := waitProjectRequest(t, requests, "wake_received")
	sendProjectCommand(m, command)
	command.InputIDs = []int64{3}
	sendProjectCommand(m, command)
	deadline := time.NewTimer(projectReceiptTimeout + 2*time.Second)
	defer deadline.Stop()
	var payloads []string
	for len(payloads) < 2 {
		select {
		case req := <-requests:
			if req.Operation == "wake_received" {
				payloads = append(payloads, string(req.Payload))
			}
		case <-deadline.C:
			t.Fatal("lost wake reply blocked duplicate and later input receipts")
		}
	}
	if payloads[0] != string(first.Payload) || payloads[1] != `{"input_ids":[3]}` {
		t.Fatalf("wake retry changed IDs or used a high-water mark: %v", payloads)
	}
}
