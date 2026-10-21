package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/protocol"
)

func TestThreadConcurrentDuplicatesAndReplyAttachments(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	var group sync.WaitGroup
	failures := make(chan error, 100)
	for range 100 {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := w.EnqueueThreadMessage(context.Background(), "same", "same content", "queue"); err != nil {
				failures <- err
			}
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	if len(a.sends) != 1 || threadCount(t, w, `SELECT COUNT(*) FROM thread_messages`) != 1 {
		t.Fatal("duplicate sends")
	}
	path := filepath.Join(w.options.WorkingDirectory, "report.txt")
	threadMust(t, os.WriteFile(path, []byte("report"), 0o600))
	a.add(agent.Event{Kind: agent.EventReply, Content: "见 `report.txt`", Metadata: json.RawMessage(`{"exit_code":0}`)}, agent.Event{Kind: agent.EventTurnEnded})
	threadMust(t, w.Poll(context.Background()))
	reports := threadReports(t, w)
	reply := reports[len(reports)-2]
	var refs []fileaccess.ThreadAttachment
	threadMust(t, json.Unmarshal(reply.Attachments, &refs))
	if len(refs) != 1 || refs[0].Path != "report.txt" || refs[0].NodeID != w.options.NodeID {
		t.Fatalf("attachments=%+v", refs)
	}
	var stored string
	threadMust(t, w.db.QueryRow(`SELECT attachments FROM thread_replies`).Scan(&stored))
	if stored != string(reply.Attachments) {
		t.Fatal("reply and report differ")
	}
}

func TestThreadQueuedCrashRecoveryAndAcknowledgedReports(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	threadMust(t, w.transaction(func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO thread_messages(client_message_id,mode,content,status) VALUES('queued','queue','body','queued')`); err != nil {
			return err
		}
		return w.report(tx, protocol.ThreadReport{Kind: "message.queued", ClientMessageID: "queued"})
	}))
	reports := threadReports(t, w)
	threadMust(t, w.ThreadAck(reports[0].EventID, reports[0].WorkerSeq))
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	b := &threadFake{resume: true}
	restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	if len(b.sends) != 1 || b.sends[0] != "queued" {
		t.Fatal("lost queued message")
	}
	pending := threadReports(t, restored)
	if pending[0].EventID != reports[1].EventID || pending[0].WorkerSeq != 2 {
		t.Fatal("report identity changed after recovery")
	}
	for i, r := range pending {
		if r.WorkerSeq != int64(i+2) {
			t.Fatal("sequence gap after recovery")
		}
	}
}

func TestThreadShellCompletesOnceAndRecoversCompletion(t *testing.T) {
	a := &threadFake{resume: false}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.AgentType = "shell" }, a)
	threadMessage(t, w, "command", "queue")
	if err := w.EnqueueThreadMessage(context.Background(), "second", "echo bad", "queue"); err == nil {
		t.Fatal("accepted second shell command")
	}
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	b := &threadFake{resume: false}
	b.add(agent.Event{Kind: agent.EventReply, Content: "command output", Metadata: json.RawMessage(`{"exit_code":0}`)}, agent.Event{Kind: agent.EventTurnEnded})
	restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	if threadState(t, restored) != "stopped" || len(b.sends) != 0 || threadCount(t, restored, `SELECT COUNT(*) FROM thread_replies`) != 1 {
		t.Fatal("lost shell completion or repeated command")
	}
}

func TestThreadInitialDirectoryFailureDoesNotLaunchAdapter(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.WorkingDirectory = filepath.Join(o.WorkingDirectory, "missing") }, a)
	reports := threadReports(t, w)
	if len(a.configs) != 0 || len(reports) != 1 || reports[0].Kind != "thread.open_failed" {
		t.Fatalf("configs=%v reports=%+v", a.configs, reports)
	}
}

func TestThreadFrameLimitAndConflictingOpen(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, nil, a)
	if err := w.EnqueueThreadMessage(context.Background(), "large", string(make([]byte, 64<<10)), "queue"); err == nil {
		t.Fatal("accepted escaped oversized frame")
	}
	if threadCount(t, w, `SELECT COUNT(*) FROM thread_messages`) != 0 {
		t.Fatal("oversized message persisted")
	}
	bad := w.options
	bad.StorageGeneration = mustSessionID(t)
	if db, _, err := openThreadDB(w.dataDir, bad, true); err == nil {
		db.Close()
		t.Fatal("accepted storage generation change")
	}
}
