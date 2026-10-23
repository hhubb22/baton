package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"baton/internal/protocol"
)

// 这些结构来自已批准的适配器契约；冻结 Go 版不执行异步命令。
type migrationWorkerAdapterConfig struct {
	Home       string `json:"home,omitempty"`
	Binary     string `json:"binary,omitempty"`
	Model      string `json:"model,omitempty"`
	StatePath  string `json:"state_path,omitempty"`
	SessionDir string `json:"session_dir,omitempty"`
}
type migrationWorkerOpenConfig struct {
	ThreadID                string                       `json:"thread_id"`
	NodeID                  string                       `json:"node_id"`
	StorageGeneration       string                       `json:"storage_generation"`
	AgentType               string                       `json:"agent_type"`
	Model                   string                       `json:"model,omitempty"`
	WorkingDirectory        string                       `json:"working_directory"`
	ExecutionTimeoutSeconds int                          `json:"execution_timeout_seconds"`
	AdapterConfig           migrationWorkerAdapterConfig `json:"adapter_config"`
}
type migrationWorkerReceipt struct {
	CommandID         string `json:"command_id"`
	ThreadID          string `json:"thread_id"`
	StorageGeneration string `json:"storage_generation"`
	Action            string `json:"action"`
}
type migrationWorkerStatus struct {
	CommandID      string `json:"command_id"`
	State          string `json:"state"`
	CommandOutcome string `json:"command_outcome,omitempty"`
	Reason         string `json:"reason,omitempty"`
}
type migrationWorkerMessage struct {
	ipcMessage
	CommandID         string                     `json:"command_id,omitempty"`
	ThreadID          string                     `json:"thread_id,omitempty"`
	StorageGeneration string                     `json:"storage_generation,omitempty"`
	WorkerReady       *bool                      `json:"worker_ready,omitempty"`
	AgentReady        *bool                      `json:"agent_ready,omitempty"`
	Receipt           *migrationWorkerReceipt    `json:"receipt,omitempty"`
	CommandStatus     *migrationWorkerStatus     `json:"command_status,omitempty"`
	OpenConfig        *migrationWorkerOpenConfig `json:"open_config,omitempty"`
}
type migrationDevicesChanged struct {
	Type          string `json:"type"`
	NodeID        string `json:"node_id"`
	ReportVersion int64  `json:"report_version"`
}
type migrationFixtureCase struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Value  any    `json:"value"`
}

func migrationOpenConfig() migrationWorkerOpenConfig {
	const id = "12345678-1234-4234-8234-123456789abc"
	return migrationWorkerOpenConfig{ThreadID: id, NodeID: id, StorageGeneration: "generation-1", AgentType: "codex", Model: "gpt-6.1-sol", WorkingDirectory: "/work/baton", ExecutionTimeoutSeconds: 7200, AdapterConfig: migrationWorkerAdapterConfig{Home: "/home/fixture/.codex", Binary: "codex", StatePath: "/private/thread/native/state.json", SessionDir: "/private/thread/native"}}
}

func TestExportMigrationProtocolFixtures(t *testing.T) {
	const id = "12345678-1234-4234-8234-123456789abc"
	const otherID = "22345678-1234-4234-8234-123456789abc"
	cases, invalid := []migrationFixtureCase{}, []migrationFixtureCase{}
	add := func(schema, name string, value any) { cases = append(cases, migrationFixtureCase{schema, name, value}) }
	reject := func(schema, name string, value any) {
		invalid = append(invalid, migrationFixtureCase{schema, name, value})
	}
	config := migrationOpenConfig()
	add("WorkerOpenConfig", "codex", config)
	add("WorkerAdapterConfig", "paths", config.AdapterConfig)
	for _, action := range []string{"open", "message", "withdraw", "resume", "stop"} {
		receipt := migrationWorkerReceipt{CommandID: id, ThreadID: id, StorageGeneration: "generation-1", Action: action}
		add("WorkerCommandReceipt", action, receipt)
		request := migrationWorkerMessage{ipcMessage: ipcMessage{Type: "thread_" + action}, CommandID: id, ThreadID: id, StorageGeneration: "generation-1"}
		if action == "open" {
			request.OpenConfig = &config
		}
		if action == "message" {
			request.ClientMessageID = "input-1"
			request.Payload = "运行本地检查"
			request.Mode = "queue"
		}
		if action == "withdraw" {
			request.ClientMessageID = "input-1"
		}
		if action == "stop" {
			request.StopReason = "employee_stop"
		}
		add("WorkerRequest", action, request)
		for _, state := range []string{"accepted", "running", "succeeded", "failed", "cancelled", "unknown"} {
			status := migrationWorkerStatus{CommandID: id, State: state}
			if state != "accepted" && state != "running" {
				status.CommandOutcome = state
				status.Reason = "命令已经结束"
			}
			add("WorkerCommandStatus", action+"."+state, status)
			response := migrationWorkerMessage{ipcMessage: ipcMessage{Type: "result", OK: true, PID: 1234, SessionID: id}, StorageGeneration: "generation-1", Receipt: &receipt, CommandStatus: &status}
			add("WorkerCommandResult", action+"."+state, response)
		}
	}
	add("WorkerRequest", "query", migrationWorkerMessage{ipcMessage: ipcMessage{Type: "thread_command_status"}, CommandID: id, ThreadID: id, StorageGeneration: "generation-1"})
	add("WorkerIPCMessage", "query.not_found", ipcMessage{Type: "result", Code: "command_not_found", Message: "命令尚未持久接收"})
	for _, version := range []int64{0, 1, 2} {
		add("DevicesChanged", "report_version", migrationDevicesChanged{Type: "devices.changed", NodeID: id, ReportVersion: version})
	}
	reject("DevicesChanged", "wrong_type", migrationDevicesChanged{Type: "thread.changed", NodeID: id, ReportVersion: 1})
	reject("DevicesChanged", "bad_node", migrationDevicesChanged{Type: "devices.changed", NodeID: "other", ReportVersion: 1})
	reject("DevicesChanged", "negative_version", migrationDevicesChanged{Type: "devices.changed", NodeID: id, ReportVersion: -1})
	reject("DevicesChanged", "missing_version", map[string]any{"type": "devices.changed", "node_id": id})
	reject("WorkerCommandStatus", "accepted_with_outcome", migrationWorkerStatus{CommandID: id, State: "accepted", CommandOutcome: "succeeded"})
	reject("WorkerCommandStatus", "terminal_without_outcome", migrationWorkerStatus{CommandID: id, State: "succeeded"})
	reject("WorkerCommandStatus", "terminal_mismatch", migrationWorkerStatus{CommandID: id, State: "succeeded", CommandOutcome: "unknown"})
	receipt := migrationWorkerReceipt{CommandID: id, ThreadID: id, StorageGeneration: "generation-1", Action: "resume"}
	reject("WorkerCommandResult", "wrong_command", migrationWorkerMessage{ipcMessage: ipcMessage{Type: "result", OK: true}, Receipt: &receipt, CommandStatus: &migrationWorkerStatus{CommandID: otherID, State: "running"}})
	reject("WorkerRequest", "missing_command_id", migrationWorkerMessage{ipcMessage: ipcMessage{Type: "thread_resume"}, ThreadID: id, StorageGeneration: "generation-1"})
	wrongConfig := config
	wrongConfig.ThreadID = otherID
	reject("WorkerRequest", "foreign_open_config", migrationWorkerMessage{ipcMessage: ipcMessage{Type: "thread_open"}, CommandID: id, ThreadID: id, StorageGeneration: "generation-1", OpenConfig: &wrongConfig})
	reject("WorkerRequest", "missing_open_config", migrationWorkerMessage{ipcMessage: ipcMessage{Type: "thread_open"}, CommandID: id, ThreadID: id, StorageGeneration: "generation-1"})
	reject("RuntimeAgent", "credential_reason", struct {
		protocol.RuntimeAgent
		Reason string `json:"reason"`
	}{protocol.RuntimeAgent{AgentType: "cursor", Version: "1.0.35", Status: "unverified", Models: []protocol.RuntimeModel{}}, "Authorization: Bearer fixture-not-a-real-credential"})
	// 完成与接收可以两种顺序到达；顺序不改变字段或命令身份。
	completion := struct {
		protocol.ThreadReport
		CommandID      string `json:"command_id"`
		CommandOutcome string `json:"command_outcome"`
	}{protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: otherID, WorkerSeq: 2, Kind: "command.completed", StorageGeneration: "generation-1", Reason: "命令已完成"}, id, "succeeded"}
	ack := protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: id, OK: true}
	add("CommandCompleted", "completion_before_ack", completion)
	add("CommandCompleted", "completion_after_ack", completion)
	add("ThreadCommandResult", "ack_after_completion", ack)
	add("ThreadCommandResult", "ack_before_completion", ack)
	reject("ThreadOpenCommandResult", "open_ack_without_generation", ack)
	document := struct {
		Source  string                 `json:"source"`
		Cases   []migrationFixtureCase `json:"cases"`
		Invalid []migrationFixtureCase `json:"invalid"`
	}{"specs/agent-adapters/TECH.md · test-only contracts", cases, invalid}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join("..", "..", "packages", "protocol", "fixtures", "go-migration.json")
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(target, append(raw, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	t.Logf("导出 %d 个迁移契约样例、%d 个无效样例", len(cases), len(invalid))
}
