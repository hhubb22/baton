package node

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"baton/internal/protocol"
)

func TestThreadInitialModelSurvivesLedgerReopen(t *testing.T) {
	ledger := openTestLedger(t)
	cmd := protocol.ThreadCommand{
		ThreadID: threadUUID(t), AgentType: "pi", Model: "provider/model",
		WorkingDirectory: t.TempDir(), ExecutionTimeoutSeconds: 7200,
	}
	if err := ledger.insertThread(t.Context(), threadUUID(t), cmd); err != nil {
		t.Fatal(err)
	}
	dir, generation := ledger.dir, ledger.Generation()
	if err := ledger.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	record, err := reopened.Thread(t.Context(), cmd.ThreadID)
	if err != nil || record.Model != cmd.Model || record.StorageGeneration != generation {
		t.Fatalf("Thread 模型没有随账本保存：%+v %v", record, err)
	}
}

func TestThreadModelUpgradePreservesExistingMapping(t *testing.T) {
	ledger := openTestLedger(t)
	cmd := protocol.ThreadCommand{
		ThreadID: threadUUID(t), AgentType: "codex", WorkingDirectory: filepath.Join(t.TempDir(), "work"),
		ExecutionTimeoutSeconds: 7200,
	}
	if err := ledger.insertThread(t.Context(), threadUUID(t), cmd); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.db.Exec(`ALTER TABLE threads DROP COLUMN model`); err != nil {
		t.Fatal(err)
	}
	dir, generation := ledger.dir, ledger.Generation()
	if err := ledger.Close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		reopened, err := OpenLedger(dir)
		if err != nil {
			t.Fatal(err)
		}
		record, err := reopened.Thread(t.Context(), cmd.ThreadID)
		if err != nil || record.Model != "" || record.WorkingDirectory != cmd.WorkingDirectory || record.StorageGeneration != generation {
			t.Fatalf("旧 Thread 映射升级错误：%+v %v", record, err)
		}
		if err := reopened.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestThreadOpenRejectsDifferentInitialModel(t *testing.T) {
	service, host, cmd := threadTestService(t)
	cmd.Model = "initial-model"
	if result, err := service.command(t.Context(), threadUUID(t), cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	if result, err := service.command(t.Context(), threadUUID(t), cmd); err != nil || !result.OK || host.count("open") != 1 {
		t.Fatalf("相同模型重复新建没有复用映射：%+v %v", result, err)
	}
	cmd.Model = "other-model"
	result, err := service.command(t.Context(), threadUUID(t), cmd)
	if err != nil || result.OK || result.Code != "thread_conflict" || host.count("open") != 1 {
		t.Fatalf("重复新建没有检查初始模型：%+v %v", result, err)
	}
}

func TestThreadModelValidation(t *testing.T) {
	for _, test := range []struct {
		name, model string
		valid       bool
	}{
		{"default", "", true},
		{"qualified", "provider/model", true},
		{"max_bytes", strings.Repeat("m", 512), true},
		{"unicode_max_bytes", strings.Repeat("模", 170) + "ab", true},
		{"too_long", strings.Repeat("m", 513), false},
		{"unicode_too_long", strings.Repeat("模", 171), false},
		{"invalid_utf8", string([]byte{0xff}), false},
		{"newline", "model\n", false},
		{"nul", "model\x00", false},
		{"unicode_control", "model\u0085", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, action := range []string{"open", "message"} {
				cmd := protocol.ThreadCommand{
					Type: protocol.BodyThreadCommand, ThreadID: threadUUID(t), Action: action,
					AgentType: "pi", WorkingDirectory: t.TempDir(), Model: test.model,
					ClientMessageID: threadUUID(t), Content: "continue", Mode: "queue",
				}
				if got := validThreadCommand(threadUUID(t), cmd); got != test.valid {
					t.Fatalf("%s 模型边界检查：got=%v want=%v", action, got, test.valid)
				}
			}
		})
	}
}

type modelCapturingThreadHost struct {
	ThreadHost
	message protocol.ThreadCommand
}

func (h *modelCapturingThreadHost) ThreadMessage(ctx context.Context, id string, cmd protocol.ThreadCommand) error {
	h.message = cmd
	return h.ThreadHost.ThreadMessage(ctx, id, cmd)
}

func TestThreadMessageModelIsForwardedAndPartOfIdentity(t *testing.T) {
	service, host, cmd := threadTestService(t)
	if result, err := service.command(t.Context(), threadUUID(t), cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	capture := &modelCapturingThreadHost{ThreadHost: host}
	service.host = capture
	cmd.Action, cmd.StorageGeneration = "message", service.ledger.Generation()
	cmd.ClientMessageID, cmd.Content, cmd.Mode, cmd.Model = threadUUID(t), "continue", "queue", "new-model"
	id := threadUUID(t)
	for range 2 {
		if result, err := service.command(t.Context(), id, cmd); err != nil || !result.OK {
			t.Fatal(result, err)
		}
	}
	if capture.message.Model != cmd.Model || host.count("message") != 1 {
		t.Fatalf("消息模型未传入 Worker 或被重复派发：%+v", capture.message)
	}
	cmd.Model = "different-model"
	if _, err := service.command(t.Context(), id, cmd); err == nil || host.count("message") != 1 {
		t.Fatal("同一命令 ID 携带不同模型没有冲突")
	}
}
func TestThreadMessageRejectsSteerWithModel(t *testing.T) {
	service, host, cmd := threadTestService(t)
	cmd.Action, cmd.ClientMessageID = "message", threadUUID(t)
	cmd.Content, cmd.Mode, cmd.Model = "continue", "steer", "other-model"
	result, err := service.command(t.Context(), threadUUID(t), cmd)
	if err != nil || result.OK || result.Code != "invalid_command" || host.count("message") != 0 {
		t.Fatalf("插入消息携带模型仍被接受：%+v %v", result, err)
	}
}
