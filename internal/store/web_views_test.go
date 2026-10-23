package store_test

import (
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"errors"
	"sync"
	"testing"
)

func TestProjectCreateIDConcurrentRetryAndChangedProject(t *testing.T) {
	h := newThreadHarness(t)
	in := projectagent.CreateInput{ClientProjectID: mustUUID(t), Title: "original", Goal: "original goal"}
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	errs := make(chan error, 12)
	for range 12 {
		wg.Go(func() { p, err := h.repo.CreateProject(h.ctx, h.owner, in); ids <- p.ID; errs <- err })
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id string
	for next := range ids {
		if id != "" && id != next {
			t.Fatal("duplicate project")
		}
		id = next
	}
	title := "edited after create"
	if _, err := h.repo.PatchProject(h.ctx, h.owner, id, projectagent.Patch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	p, err := h.repo.CreateProject(h.ctx, h.owner, in)
	if err != nil || p.ID != id || p.Title != title {
		t.Fatal(p, err)
	}
	in.Goal = "different"
	if _, err := h.repo.CreateProject(h.ctx, h.owner, in); !errors.Is(err, projectagent.ErrProjectConflict) {
		t.Fatal(err)
	}
	if n := h.count(`SELECT count(*) FROM projects`); n != 1 {
		t.Fatal(n)
	}
}

func TestThreadTraceReadsStoredShellCommandAndOutput(t *testing.T) {
	h := newThreadHarness(t)
	if _, err := h.repo.SaveRuntimeReport(h.ctx, h.src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Enabled: true, Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}}); err != nil {
		t.Fatal(err)
	}
	p, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "Shell trace"})
	if err != nil {
		t.Fatal(err)
	}
	in := h.input("shell-trace", h.src.NodeID)
	in.ProjectID = p.ID
	in.OriginConversationID = p.Conversation.ID
	in.OriginToolCallID = "trace-call"
	in.CreatedBy = "project_agent"
	in.AgentType = "shell"
	in.Message.Content = "printf actual-output"
	v, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil {
		t.Fatal(err)
	}
	h.opened(v)
	h.start(v, 2, 1, "shell-trace:first")
	h.report(v.ID, 4, "reply", func(r *protocol.ThreadReport) {
		r.WorkerTurnSeq = 1
		r.Content = "actual-output"
		r.Truncated = true
		r.OriginalBytes = 1024
	})
	trace, err := h.repo.ThreadTrace(h.ctx, h.owner, v.ID, 1)
	if err != nil || !trace.OK || len(trace.Steps) != 1 || trace.Steps[0].Command != in.Message.Content || trace.Steps[0].Output != "actual-output" || !trace.Steps[0].Truncated {
		t.Fatal(trace, err)
	}
}
