package store_test

import (
	"crypto/sha256"
	"encoding/json"
	"reflect"
	"testing"

	"baton/internal/protocol"
)

func TestThreadReportLegacyHashReplayAfterModelUpgrade(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("legacy-report-hash")
	report := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 1, Kind: "thread.opened", StorageGeneration: "generation", NativeSessionID: "native", Model: "model-a"}
	wire, err := protocol.MarshalJSON(report)
	if err != nil {
		t.Fatal(err)
	}
	// 旧中心解码时忽略 Model，再按旧结构编码已知字段生成摘要。
	var legacy struct {
		Type              string `json:"type"`
		ThreadID          string `json:"thread_id"`
		EventID           string `json:"event_id"`
		WorkerSeq         int64  `json:"worker_seq"`
		Kind              string `json:"kind"`
		StorageGeneration string `json:"storage_generation,omitempty"`
		NativeSessionID   string `json:"native_session_id,omitempty"`
	}
	if err = json.Unmarshal(wire, &legacy); err != nil {
		t.Fatal(err)
	}
	legacyWire, err := protocol.MarshalJSON(legacy)
	if err != nil {
		t.Fatal(err)
	}
	legacyHash := sha256.Sum256(legacyWire)
	var legacyReport protocol.ThreadReport
	if err = json.Unmarshal(legacyWire, &legacyReport); err != nil {
		t.Fatal(err)
	}
	originalACK, err := h.repo.SaveThreadReport(h.ctx, h.src, legacyReport)
	if err != nil || !originalACK.OK {
		t.Fatal(originalACK, err)
	}
	// 迁移的默认版本标识旧中心已处理、但 ACK 未送达的记录。
	var version int
	if err = h.pool.QueryRow(h.ctx, `UPDATE thread_reports SET payload_hash=$3,payload_hash_version=DEFAULT WHERE thread_id=$1 AND event_id=$2 RETURNING payload_hash_version`, v.ID, report.EventID, legacyHash[:]).Scan(&version); err != nil || version != 1 {
		t.Fatal(version, err)
	}
	before, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || before.Model != "" {
		t.Fatal(before, err)
	}
	eventsBefore := h.count(`SELECT count(*) FROM thread_events`)
	for range 2 {
		ack, err := h.repo.SaveThreadReport(h.ctx, h.src, report)
		if err != nil || ack != originalACK {
			t.Fatal("upgraded coordinator rejected old report retry", ack, originalACK, err)
		}
	}
	after, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || !reflect.DeepEqual(before, after) || h.count(`SELECT count(*) FROM thread_events`) != eventsBefore || h.count(`SELECT count(*) FROM thread_reports`) != 1 {
		t.Fatal("legacy retry reapplied report", before, after, err)
	}
	report.NativeSessionID = "changed-native"
	_, err = h.repo.SaveThreadReport(h.ctx, h.src, report)
	threadRejection(t, err, 409)
}

func TestThreadReportVersion2ModelConflicts(t *testing.T) {
	for _, model := range []string{"", "model-a"} {
		t.Run("initial-model="+model, func(t *testing.T) {
			h := newThreadHarness(t)
			v := h.create("version-2-report")
			report := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 1, Kind: "thread.opened", StorageGeneration: "generation", Model: model}
			originalACK, err := h.repo.SaveThreadReport(h.ctx, h.src, report)
			if err != nil || !originalACK.OK {
				t.Fatal(originalACK, err)
			}
			wire, err := protocol.MarshalJSON(report)
			if err != nil {
				t.Fatal(err)
			}
			wantHash := sha256.Sum256(wire)
			var version int
			var savedHash []byte
			if err = h.pool.QueryRow(h.ctx, `SELECT payload_hash_version,payload_hash FROM thread_reports WHERE thread_id=$1 AND event_id=$2`, v.ID, report.EventID).Scan(&version, &savedHash); err != nil || version != 2 || string(savedHash) != string(wantHash[:]) {
				t.Fatalf("version=%d hash=%x want=%x: %v", version, savedHash, wantHash, err)
			}
			if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, report); err != nil || ack != originalACK {
				t.Fatal(ack, err)
			}
			report.Model = "model-b"
			_, err = h.repo.SaveThreadReport(h.ctx, h.src, report)
			threadRejection(t, err, 409)
			view, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
			if err != nil || view.Model != model || view.LastWorkerSeq != 1 || h.count(`SELECT count(*) FROM thread_reports`) != 1 {
				t.Fatal("conflicting model applied", view, err)
			}
		})
	}
}
