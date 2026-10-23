package httpapi_test

import (
	"encoding/json"
	"testing"

	"baton/internal/store"
)

func TestThreadHTTPListSummaries(t *testing.T) {
	h := newThreadHTTP(t)
	v := h.create("list-summary")
	h.report(v.ID, 1, "thread.opened", 0, "", "")
	h.report(v.ID, 2, "turn.started", 1, "list-summary:first", "")
	h.report(v.ID, 3, "message.sent", 1, "list-summary:first", "")
	path := "/threads/" + v.ID
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "queued", Content: "private queued content"}, 202)
	h.post(path+"/stop", struct{}{}, 202)
	h.report(v.ID, 4, "message.withdrawn", 0, "queued", "")
	calls := h.gateway.calls.Load()

	assertList := func(wantTurn bool) {
		t.Helper()
		status, body := getText(t, h.browser, h.srv.URL+"/api/v1/threads?limit=1&node_id="+h.src.NodeID)
		var page struct {
			Threads    []map[string]json.RawMessage `json:"threads"`
			NextCursor string                       `json:"next_cursor"`
		}
		if status != 200 || json.Unmarshal([]byte(body), &page) != nil || len(page.Threads) != 1 || page.NextCursor != "" {
			t.Fatalf("list: %d %s", status, body)
		}
		fields := page.Threads[0]
		for key, want := range map[string]string{
			"id": `"` + v.ID + `"`, "employee_id": `"` + h.owner + `"`,
			"title": `"hello"`, "stop_canceled": "1", "node_online": "true", "node_synced": "true",
		} {
			if string(fields[key]) != want {
				t.Fatalf("%s: %s, want %s", key, fields[key], want)
			}
		}
		if wantTurn {
			var turn store.ThreadTurn
			if err := json.Unmarshal(fields["current_turn"], &turn); err != nil || turn.ID == "" || turn.ThreadID != v.ID || turn.WorkerTurnSeq != 1 || turn.StartedAt.IsZero() || turn.EndedAt != nil {
				t.Fatalf("current turn: %+v %v", turn, err)
			}
		} else if string(fields["current_turn"]) != "null" {
			t.Fatalf("current_turn: %s", fields["current_turn"])
		}
		for _, key := range []string{"thread", "events", "pending_messages", "failed_messages", "request_hash"} {
			if _, ok := fields[key]; ok {
				t.Fatalf("unexpected %s in list: %s", key, body)
			}
		}
		if h.gateway.calls.Load() != calls {
			t.Fatal("list requested node session data")
		}
	}
	assertList(true)
	h.report(v.ID, 5, "turn.ended", 1, "", "stopped")
	assertList(false)
}
