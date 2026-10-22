package node

import (
	"baton/internal/protocol"
	"testing"
)

func TestThreadCommandReceiptIncludesModelAfterReopen(t *testing.T) {
	ledger := openTestLedger(t)
	cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: threadUUID(t), Action: "message", ClientMessageID: threadUUID(t), Content: "继续", Model: "provider/model"}
	id := threadUUID(t)
	result := protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: cmd.ThreadID, OK: true}
	if err := ledger.saveThreadReceipt(t.Context(), id, cmd, result); err != nil {
		t.Fatal(err)
	}
	dir := ledger.dir
	if err := ledger.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, found, err := reopened.threadReceipt(t.Context(), id, cmd)
	if err != nil || !found || got != result {
		t.Fatal(got, found, err)
	}
	cmd.Model = "other/model"
	if _, _, err := reopened.threadReceipt(t.Context(), id, cmd); err == nil {
		t.Fatal("回执忽略了模型冲突")
	}
}
