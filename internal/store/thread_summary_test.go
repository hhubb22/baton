package store_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

func TestThreadListSummaryTitles(t *testing.T) {
	h := newThreadHarness(t)
	for i, tc := range []struct {
		name, content, want string
	}{
		{"first line", "标题🙂\nsecond line", "标题🙂"},
		{"unicode limit", strings.Repeat("中🙂a", 41) + "\nsecond line", strings.Repeat("中🙂a", 40)},
		{"short first line", "short\n" + strings.Repeat("中", 150), "short"},
		{"empty first line", "\nsecond line", "/src/repo"},
		{"whitespace preserved", "  title  \nsecond line", "  title  "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := h.input(fmt.Sprintf("title-%d", i), h.src.NodeID)
			in.Message.Content = tc.content
			v, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "later", Content: "later title"}); err != nil {
				t.Fatal(err)
			}
			// 标题取审计快照；消息表内容和事件时间戳不决定首条事件。
			if _, err = h.pool.Exec(h.ctx, `UPDATE thread_messages SET content='changed' WHERE thread_id=$1`, v.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = h.pool.Exec(h.ctx, `INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload,created_at)
 VALUES($1::uuid,$2,'message.accepted','employee',$1::text,'{"content":"backdated"}', '2000-01-01')`, h.owner, v.ID); err != nil {
				t.Fatal(err)
			}
			page, err := h.repo.ListThreads(h.ctx, h.owner, store.ThreadFilter{Limit: 1})
			if err != nil || len(page.Threads) != 1 {
				t.Fatalf("list: %+v %v", page, err)
			}
			got := page.Threads[0]
			if got.ID != v.ID || got.Title != tc.want || got.StopCanceled != 0 || got.CurrentTurn != nil {
				t.Fatalf("summary: %+v, want title %q", got, tc.want)
			}
		})
	}

	template := h.create("template")
	for _, directory := range []string{"/src/fallback", ""} {
		id := mustUUID(t)
		if _, err := h.pool.Exec(h.ctx, `INSERT INTO threads(id,employee_id,client_thread_id,request_hash,node_id,agent_type,working_directory,created_by)
 SELECT $2::uuid,employee_id,$2::text,request_hash,node_id,agent_type,$3,created_by FROM threads WHERE id=$1`, template.ID, id, directory); err != nil {
			t.Fatal(err)
		}
		page, err := h.repo.ListThreads(h.ctx, h.owner, store.ThreadFilter{Limit: 1})
		if err != nil || len(page.Threads) != 1 {
			t.Fatalf("list without messages: %+v %v", page, err)
		}
		want := directory
		if want == "" {
			want = id
		}
		if got := page.Threads[0]; got.ID != id || got.Title != want {
			t.Fatalf("fallback: %+v, want %q", got, want)
		}
	}
}

func TestThreadListSummaryStopAndCurrentTurn(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("summary")
	h.opened(v)
	h.start(v, 2, 1, "summary:first")
	assertSummary := func(wantCanceled int, wantTurn bool) {
		t.Helper()
		page, err := h.repo.ListThreads(h.ctx, h.owner, store.ThreadFilter{})
		if err != nil || len(page.Threads) != 1 {
			t.Fatalf("list: %+v %v", page, err)
		}
		got := page.Threads[0]
		detail, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.StopCanceled != wantCanceled || (got.CurrentTurn != nil) != wantTurn || !reflect.DeepEqual(got.CurrentTurn, detail.CurrentTurn) || !reflect.DeepEqual(got.Thread, detail.Thread) {
			t.Fatalf("summary: %+v, detail: %+v, want canceled=%d turn=%v", got, detail, wantCanceled, wantTurn)
		}
		raw, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"title", "stop_canceled", "current_turn", "id", "employee_id", "node_online"} {
			if _, ok := fields[key]; !ok {
				t.Fatalf("missing %s: %s", key, raw)
			}
		}
		for _, key := range []string{"thread", "events", "pending_messages", "failed_messages", "request_hash"} {
			if _, ok := fields[key]; ok {
				t.Fatalf("unexpected %s: %s", key, raw)
			}
		}
		if !wantTurn && string(fields["current_turn"]) != "null" {
			t.Fatalf("current_turn: %s", fields["current_turn"])
		}
	}
	withdraw := func(key string, seq int64) {
		t.Helper()
		if _, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: key, Content: "queued"}); err != nil {
			t.Fatal(err)
		}
		h.report(v.ID, seq, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = key })
	}
	action := func(action string) {
		t.Helper()
		if _, err := h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, action, ""); err != nil {
			t.Fatal(err)
		}
	}

	withdraw("before-stop", 4)
	assertSummary(0, true)
	action("stop")
	withdraw("stop-one", 5)
	withdraw("stop-two", 6)
	assertSummary(2, true)
	action("stop")
	assertSummary(0, true)
	withdraw("second-stop", 7)
	assertSummary(1, true)
	if _, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "archive-one", Content: "queued"}); err != nil {
		t.Fatal(err)
	}
	action("archive")
	assertSummary(0, true)
	h.report(v.ID, 8, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = "archive-one" })
	assertSummary(1, true)
	// 批量撤回审计与 message.withdrawn 分开计数，时间戳不改变审计顺序。
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload,created_at)
 VALUES($1,$2,'messages.withdrawn','device',$3,'{"count":100}', '2000-01-01'),
 ($1,$2,'message.withdrawn','device',$3,'{}', '2000-01-01')`, h.owner, v.ID, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	assertSummary(2, true)
	h.report(v.ID, 9, "turn.ended", func(r *protocol.ThreadReport) {
		r.WorkerTurnSeq = 1
		r.Reason = "stopped"
		r.QueueEmpty = true
	})
	assertSummary(2, false)
}

func TestThreadListSummaryPaginationFiltersAndIsolation(t *testing.T) {
	h := newThreadHarness(t)
	project, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "List"})
	if err != nil {
		t.Fatal(err)
	}
	otherProject, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	otherNode := h.addNode("Other")
	var wantIDs []string
	for i := range 8 {
		in := h.input(fmt.Sprintf("page-%d", i), h.src.NodeID)
		in.ProjectID = project.ID
		in.CreatedBy = "project_agent"
		in.OriginConversationID = project.Conversation.ID
		in.OriginToolCallID = fmt.Sprintf("create-thread-%d", i)
		in.Message.Content = fmt.Sprintf("title-%d\nprivate content", i)
		if i == 5 {
			in.ProjectID = otherProject.ID
			in.OriginConversationID = otherProject.Conversation.ID
		}
		if i == 6 {
			in.NodeID = otherNode.NodeID
		}
		v, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
		if err != nil {
			t.Fatal(err)
		}
		if i != 7 {
			src := h.src
			if i == 6 {
				h.src = otherNode
			}
			h.opened(v)
			h.src = src
		}
		if i < 5 {
			wantIDs = append(wantIDs, v.ID)
		}
	}
	owner, src := h.owner, h.src
	other := mustEmployee(t, h.ctx, h.pool, "list-other", "Other")
	h.owner = other.ID
	h.src = h.addNode("Foreign")
	foreign := h.create("page-0")
	h.opened(foreign)
	h.start(foreign, 2, 1, "page-0:first")
	h.owner, h.src = owner, src

	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if _, err := h.pool.Exec(h.ctx, `UPDATE threads SET last_activity_at=$1`, at); err != nil {
		t.Fatal(err)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(wantIDs)))
	filter := store.ThreadFilter{ProjectID: project.ID, NodeID: h.src.NodeID, Status: "idle", Limit: 2}
	var gotIDs []string
	var firstCursor string
	for pageNumber := 0; ; pageNumber++ {
		page, err := h.repo.ListThreads(h.ctx, h.owner, filter)
		if err != nil {
			t.Fatal(err)
		}
		wantLen := 2
		if pageNumber == 2 {
			wantLen = 1
		}
		if pageNumber > 2 || len(page.Threads) != wantLen {
			t.Fatalf("page %d: %+v", pageNumber, page)
		}
		for _, summary := range page.Threads {
			if summary.EmployeeID != owner || summary.ProjectID != project.ID || summary.NodeID != src.NodeID || summary.Status != "idle" || !summary.NodeOnline || !summary.NodeSynced || summary.CurrentTurn != nil || summary.StopCanceled != 0 {
				t.Fatalf("filtered summary: %+v", summary)
			}
			wantTitle := "title-" + strings.TrimPrefix(summary.ClientThreadID, "page-")
			if summary.Title != wantTitle {
				t.Fatalf("title %q, want %q", summary.Title, wantTitle)
			}
			gotIDs = append(gotIDs, summary.ID)
		}
		if pageNumber == 0 {
			firstCursor = page.NextCursor
		}
		if page.NextCursor == "" {
			break
		}
		filter.Cursor = page.NextCursor
	}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("pagination: %v, want %v", gotIDs, wantIDs)
	}
	filter.Cursor = firstCursor
	for _, change := range []func(*store.ThreadFilter){
		func(f *store.ThreadFilter) { f.ProjectID = otherProject.ID },
		func(f *store.ThreadFilter) { f.NodeID = otherNode.NodeID },
		func(f *store.ThreadFilter) { f.Status = "running" },
	} {
		changed := filter
		change(&changed)
		_, err := h.repo.ListThreads(h.ctx, owner, changed)
		threadRejection(t, err, 400)
	}
	_, err = h.repo.ListThreads(h.ctx, other.ID, filter)
	threadRejection(t, err, 400)
	page, err := h.repo.ListThreads(h.ctx, other.ID, store.ThreadFilter{})
	if err != nil || len(page.Threads) != 1 || page.Threads[0].ID != foreign.ID || page.Threads[0].CurrentTurn == nil || page.Threads[0].CurrentTurn.ThreadID != foreign.ID {
		t.Fatalf("employee isolation: %+v %v", page, err)
	}
	page, err = h.repo.ListThreads(h.ctx, other.ID, store.ThreadFilter{ProjectID: project.ID})
	if err != nil || len(page.Threads) != 0 || page.NextCursor != "" {
		t.Fatalf("empty list: %+v %v", page, err)
	}
	raw, err := json.Marshal(page)
	if err != nil || string(raw) != `{"threads":[]}` {
		t.Fatalf("empty list JSON: %s %v", raw, err)
	}
}
