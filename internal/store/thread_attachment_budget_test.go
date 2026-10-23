package store_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"baton/internal/fileaccess"
	"baton/internal/protocol"
)

func TestThreadReplyLongFileAttachmentsDoNotBlockTurnEnd(t *testing.T) {
	h := newThreadHarness(t)
	data, root := t.TempDir(), t.TempDir()
	if err := fileaccess.AddBrowseRoot(data, "attachments", root); err != nil {
		t.Fatal(err)
	}
	var content strings.Builder
	names := map[string]bool{}
	for i := range 16 {
		name := fmt.Sprintf("file-%02d-%s.txt", i, strings.Repeat("x", 48))
		if err := os.WriteFile(filepath.Join(root, name), []byte("real attachment"), 0600); err != nil {
			t.Fatal(err)
		}
		names[name] = true
		fmt.Fprintf(&content, "`%s`\n", name)
	}
	refs, err := fileaccess.ParseThreadAttachments(data, h.src.NodeID, root, content.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 16 {
		t.Fatalf("source references lost: %d", len(refs))
	}
	raw, err := json.Marshal(refs)
	if err != nil {
		t.Fatal(err)
	}
	full := append([]fileaccess.ThreadAttachment(nil), refs...)
	for i := range full {
		absolute := filepath.Join(root, full[i].Path)
		info, err := os.Stat(absolute)
		if err != nil {
			t.Fatal(err)
		}
		size := info.Size()
		full[i].AbsolutePath = absolute
		full[i].Size = &size
	}
	fullRaw, _ := json.Marshal(full)
	var fullSize int
	if err := h.pool.QueryRow(h.ctx, `SELECT octet_length($1::jsonb::text)`, fullRaw).Scan(&fullSize); err != nil {
		t.Fatal(err)
	}
	if fullSize <= 4096 {
		t.Fatalf("fixture did not exceed the original JSONB budget: %d", fullSize)
	}
	var size int
	if err := h.pool.QueryRow(h.ctx, `SELECT octet_length($1::jsonb::text)`, raw).Scan(&size); err != nil {
		t.Fatal(err)
	}
	t.Logf("attachments compact=%d jsonb=%d", len(raw), size)
	v := h.create("attachment-budget")
	h.opened(v)
	h.start(v, 2, 1, "attachment-budget:first")
	reply := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 4, WorkerTurnSeq: 1, Kind: "reply", Content: content.String(), Attachments: raw}
	ack, err := h.repo.SaveThreadReport(h.ctx, h.src, reply)
	if err != nil || !ack.OK {
		t.Errorf("reply rejected: %+v %v", ack, err)
	}
	ended := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 5, WorkerTurnSeq: 1, Kind: "turn.ended", Reason: "completed", QueueEmpty: true}
	ack, err = h.repo.SaveThreadReport(h.ctx, h.src, ended)
	if err != nil || !ack.OK {
		t.Fatalf("turn.ended rejected after attachment reply: %+v %v", ack, err)
	}
	if size > 4096 {
		t.Fatalf("sender exceeded storage limit: %d", size)
	}
	var saved []byte
	if err := h.pool.QueryRow(h.ctx, `SELECT attachments FROM thread_replies WHERE thread_id=$1`, v.ID).Scan(&saved); err != nil {
		t.Fatal(err)
	}
	refs = nil
	if err := json.Unmarshal(saved, &refs); err != nil {
		t.Fatal(err)
	}
	if len(refs) != 16 {
		t.Fatalf("saved sources lost: %d", len(refs))
	}
	for _, ref := range refs {
		if ref.Kind != "file" || ref.NodeID != h.src.NodeID || ref.RootID != "attachments" || !names[ref.Path] || ref.AccessStatus != "available" {
			t.Fatalf("source changed: %+v", ref)
		}
		if ref.AbsolutePath != "" && ref.AbsolutePath != filepath.Join(root, ref.Path) {
			t.Fatalf("absolute path changed: %+v", ref)
		}
		if ref.Size != nil && *ref.Size != int64(len("real attachment")) {
			t.Fatalf("size changed: %+v", ref)
		}
		delete(names, ref.Path)
	}
	if len(names) != 0 {
		t.Fatal("source references missing", names)
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.Status != "idle" || view.CurrentTurn != nil || view.LastWorkerSeq != 5 {
		t.Fatal(view, err)
	}
}
