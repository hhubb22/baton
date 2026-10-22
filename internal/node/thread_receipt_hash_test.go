package node

import (
	"encoding/json"
	"reflect"
	"testing"

	"baton/internal/protocol"
)

func TestThreadLegacyCommandReceiptSurvivesModelUpgrade(t *testing.T) {
	service, host, cmd := threadTestService(t)
	id := threadUUID(t)
	legacy := cmd
	cmd.Model = "provider/model"
	ack := protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: cmd.ThreadID, OK: true}
	raw, err := json.Marshal(ack)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ledger.db.Exec(`INSERT INTO thread_command_receipts(message_id,request_hash,result) VALUES(?,?,?)`, id, threadRequestHash(legacy), raw); err != nil {
		t.Fatal(err)
	}
	got, err := service.command(t.Context(), id, cmd)
	if err != nil || !reflect.DeepEqual(got, ack) || host.count("open") != 0 {
		t.Fatalf("旧节点回执在升级后没有复用：%+v %v", got, err)
	}
	cmd.WorkingDirectory += "/changed"
	if _, err := service.command(t.Context(), id, cmd); err == nil {
		t.Fatal("旧回执允许修改原有字段")
	}
}

func TestThreadCommandReceiptHashUpgradePreservesReceipts(t *testing.T) {
	ledger := openTestLedger(t)
	if _, err := ledger.db.Exec(`ALTER TABLE thread_command_receipts DROP COLUMN request_hash_version`); err != nil {
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
	var version int
	cmd := protocol.ThreadCommand{ThreadID: threadUUID(t), Action: "message", Model: "provider/model"}
	id := threadUUID(t)
	if err := reopened.saveThreadReceipt(t.Context(), id, cmd, protocol.ThreadCommandResult{OK: true}); err != nil {
		t.Fatal(err)
	}
	if err := reopened.db.QueryRow(`SELECT request_hash_version FROM thread_command_receipts WHERE message_id=?`, id).Scan(&version); err != nil || version != 2 {
		t.Fatal(version, err)
	}
	cmd.Model = "other/model"
	if _, _, err := reopened.threadReceipt(t.Context(), id, cmd); err == nil {
		t.Fatal("新回执忽略了模型冲突")
	}
}
