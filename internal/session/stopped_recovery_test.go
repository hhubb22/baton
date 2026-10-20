package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"baton/internal/agent"
	"baton/internal/privatefile"
	"baton/internal/task"
)

func TestStoppedShellRecoveryWithoutCancellationRetainsCommandOutput(t *testing.T) {
	for _, exitCode := range []int{-1, 0} {
		name := "terminated"
		if exitCode == 0 {
			name = "natural_exit_raced_with_close"
		}
		t.Run(name, func(t *testing.T) {
			w, _, sid := reliabilityWorker(t)
			config := agent.Config{DataDir: t.TempDir(), SessionID: sid, ExecutionID: w.execution}
			config.SessionDir = filepath.Join(config.DataDir, "sessions", sid, "native")
			if err := os.MkdirAll(config.SessionDir, 0o700); err != nil {
				t.Fatal(err)
			}
			configJSON, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			execLedger(t, w, `UPDATE meta SET value='shell' WHERE key='agent_type'`)
			execLedger(t, w, `INSERT INTO meta(key,value) VALUES('adapter_config',?)`, string(configJSON))
			var final map[string]any
			if err := json.Unmarshal([]byte(commandStopOutput(t).Final), &final); err != nil {
				t.Fatal(err)
			}
			final["command_result"] = task.CommandResult{Output: "partial\n", TotalBytes: 8, ExitCode: exitCode}
			if exitCode == 0 {
				final["status"], final["error"] = task.StatusCompleted, nil
			}
			candidateJSON, err := json.Marshal(final)
			if err != nil {
				t.Fatal(err)
			}
			original, err := task.ParseCandidate(string(candidateJSON))
			if err != nil {
				t.Fatal(err)
			}
			record, err := json.Marshal(map[string]any{
				"schema_version": 1, "session_id": sid, "execution_id": w.execution,
				"input_generation": 1, "completion_kind": "stopped", "process_stopped": true,
				"result": json.RawMessage(candidateJSON),
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := privatefile.WriteFile(filepath.Join(config.SessionDir, "output.json"), record); err != nil {
				t.Fatal(err)
			}
			w = reopenReliabilityWorker(t, w)
			if w.cancelled || !w.inputSubmitted {
				t.Fatal("fixture does not represent a submitted execution closed without cancellation")
			}
			t.Setenv("BATON_TEST_EXECUTOR_LOG", "")
			configureAdapter(w, config.DataDir, sid)
			if err := w.restoreAdapter(sid); err != nil {
				t.Fatal(err)
			}
			if err := w.recover(sid); err != nil {
				t.Fatal(err)
			}
			result := savedResult(t, w)
			if result.CommandResult == nil || *result.CommandResult != *original.CommandResult {
				t.Fatalf("stopped recovery lost captured command output: %+v", result)
			}
			failure := task.FormatFailure(true)
			if result.Status != task.StatusNeedsVerification || result.Summary != failure.Summary || result.ErrorCode != failure.ErrorCode ||
				result.ErrorMessage != failure.ErrorMessage || !result.AgentStopped || result.OutcomeKnown || w.cancelled || !w.recoveredUncertain {
				t.Fatalf("command output changed recovery or stop semantics: %+v", result)
			}
			if countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='stop_report'`) != 0 {
				t.Fatal("recovery invented a cancellation report")
			}
			if err := w.checkDeadline(sid); err != nil {
				t.Fatal(err)
			}
			if savedResult(t, w).EventID != result.EventID || countLedger(t, w, `SELECT COUNT(*) FROM outbox WHERE kind='result'`) != 1 {
				t.Fatal("stopped recovery duplicated its uncertain result")
			}
		})
	}
}

func TestUncertainCandidateRetainsOnlyValidatedCommandOutput(t *testing.T) {
	valid := commandStopOutput(t).Final
	for _, tc := range []struct {
		name  string
		final string
		valid bool
	}{
		{name: "valid", final: valid, valid: true},
		{name: "missing", final: ""},
		{name: "invalid_json", final: "invalid"},
		{name: "invalid_candidate", final: `{"status":"failed","command_result":{"output":"partial\n","total_bytes":8,"exit_code":-1,"truncated":false}}`},
		{name: "invalid_command", final: `{"status":"failed","summary":"fixture","evidence_empty_reason":"fixture","artifacts_empty_reason":"fixture","error":{"code":"execution_failed","message":"stopped"},"command_result":{"output":"partial\n","total_bytes":9,"exit_code":-1,"truncated":false}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := terminalCandidate(Output{Final: tc.final, Exited: true, Uncertain: true})
			if candidate.Status != task.StatusNeedsVerification || candidate.ErrorCode != task.FormatFailure(true).ErrorCode {
				t.Fatalf("uncertain candidate changed its conclusion: %+v", candidate)
			}
			if (candidate.CommandResult != nil) != tc.valid {
				t.Fatalf("uncertain candidate accepted invalid output or dropped validated output: %+v", candidate)
			}
			if err := task.ValidateCandidate(candidate); err != nil {
				t.Fatal(err)
			}
		})
	}
}
