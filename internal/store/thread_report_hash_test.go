package store_test

import (
	"crypto/sha256"
	"testing"

	"baton/internal/protocol"
)

func TestThreadReportModelConflicts(t *testing.T) {
	for _, model := range []string{"", "model-a"} {
		t.Run("initial-model="+model, func(t *testing.T) {
			h := newThreadHarness(t)
			v := h.create("model-report")
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
			var savedHash []byte
			if err = h.pool.QueryRow(h.ctx, `SELECT payload_hash FROM thread_reports WHERE thread_id=$1 AND event_id=$2`, v.ID, report.EventID).Scan(&savedHash); err != nil || string(savedHash) != string(wantHash[:]) {
				t.Fatalf("hash=%x want=%x: %v", savedHash, wantHash, err)
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
