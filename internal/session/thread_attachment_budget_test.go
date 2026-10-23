package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/protocol"
)

func TestThreadWorkerSendsBoundedAttachmentsBeforeTurnEnd(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	dir := filepath.Join(w.options.WorkingDirectory, "packages", "components", "src", "generated")
	threadMust(t, os.MkdirAll(dir, 0700))
	var body strings.Builder
	for i := range 16 {
		path := filepath.Join(dir, fmt.Sprintf("Component%02d.tsx", i))
		threadMust(t, os.WriteFile(path, []byte("x"), 0600))
		relative, err := filepath.Rel(w.options.WorkingDirectory, path)
		threadMust(t, err)
		fmt.Fprintf(&body, "`%s`\n", filepath.ToSlash(relative))
	}
	threadMessage(t, w, "files", "queue")
	a.add(agent.Event{Kind: agent.EventReply, Content: body.String()}, agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
	threadMust(t, w.Poll(t.Context()))
	reports := threadReports(t, w)
	var reply *protocol.ThreadReport
	for i := range reports {
		if reports[i].Kind == "reply" {
			reply = &reports[i]
		}
	}
	if reply == nil {
		t.Fatal("reply not saved")
	}
	var refs []fileaccess.ThreadAttachment
	threadMust(t, json.Unmarshal(reply.Attachments, &refs))
	if len(refs) != 16 || len(reply.Attachments) > protocol.MaxThreadAttachmentsBytes {
		t.Fatal("invalid wire attachments", len(refs), len(reply.Attachments))
	}
	for _, ref := range refs {
		if ref.NodeID != w.options.NodeID || ref.RootID != "dev" || ref.Path == "" {
			t.Fatalf("attachment source lost: %+v", ref)
		}
	}
	last := reports[len(reports)-1]
	if last.Kind != "turn.ended" || last.WorkerSeq != reply.WorkerSeq+1 || last.WorkerTurnSeq != reply.WorkerTurnSeq {
		t.Fatal("reply/turn sequence broken", reply, last)
	}
	var saved string
	threadMust(t, w.db.QueryRow(`SELECT attachments FROM thread_replies`).Scan(&saved))
	if saved != string(reply.Attachments) {
		t.Fatal("wire attachments differ from local reply")
	}
}
