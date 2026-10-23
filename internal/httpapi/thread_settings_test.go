package httpapi_test

import (
	"baton/internal/protocol"
	"baton/internal/store"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestThreadWebModelResumeOutputAndTrace(t *testing.T) {
	h := newThreadHTTP(t)
	agents := []protocol.RuntimeAgent{{AgentType: "pi", Version: "1", Status: "available", DefaultModel: "a", Models: []protocol.RuntimeModel{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}}, Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Resume: true, SwitchModel: true}}}
	if _, err := h.repo.SaveRuntimeReport(t.Context(), h.src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: agents}); err != nil {
		t.Fatal(err)
	}
	v := h.create("settings")
	base := "/threads/" + v.ID
	h.post(base+"/model", map[string]string{"model": "missing"}, 422)
	var view store.ThreadView
	body := h.post(base+"/model", map[string]string{"model": "b"}, 200)
	if json.Unmarshal([]byte(body), &view) != nil || view.Model != "a" || view.NextModel != "b" {
		t.Fatal(body)
	}
	body = h.post(base+"/messages", map[string]string{"client_message_id": "next", "content": "next"}, 202)
	var message store.ThreadMessage
	if json.Unmarshal([]byte(body), &message) != nil || message.Model != "b" {
		t.Fatal(body)
	}
	h.post(base+"/model", map[string]string{"model": "a"}, 200)
	h.post(base+"/messages", map[string]string{"client_message_id": "next", "content": "next"}, 202)
	h.report(v.ID, 1, "thread.opened", 0, "", "")
	h.report(v.ID, 2, "turn.started", 1, "settings:first", "")
	h.report(v.ID, 3, "message.sent", 1, "settings:first", "")
	h.post(base+"/resume", struct{}{}, 409)
	h.report(v.ID, 4, "turn.ended", 1, "", "completed")
	h.report(v.ID, 5, "thread.stopped", 0, "", "stopped")
	body = h.post(base+"/resume", struct{}{}, 202)
	if json.Unmarshal([]byte(body), &view) != nil || view.Status != "stopped" || !view.ResumePending {
		t.Fatal(body)
	}
	h.post(base+"/resume", struct{}{}, 202)
	var n int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM thread_outbox WHERE thread_id=$1 AND action='resume'`, v.ID).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	h.report(v.ID, 6, "thread.resumed", 0, "", "")
	_, body = getText(t, h.browser, h.srv.URL+"/api/v1"+base)
	if !strings.Contains(body, `"status":"idle"`) {
		t.Fatal(body)
	}
	status, body := getText(t, h.browser, h.srv.URL+"/api/v1"+base+"/output?cursor=old:0")
	if status != 200 || !strings.Contains(body, `"text":"live output"`) {
		t.Fatal(status, body)
	}
	status, body = getText(t, h.browser, h.srv.URL+"/api/v1"+base+"/trace?worker_turn_seq=1")
	if status != 200 || !strings.Contains(body, `"code":"trace_missing"`) {
		t.Fatal(status, body)
	}
	if err := h.repo.MarkOffline(t.Context(), h.src.NodeID, h.src.ConnID, time.Now()); err != nil {
		t.Fatal(err)
	}
	status, body = getText(t, h.browser, h.srv.URL+"/api/v1"+base+"/output")
	if status != 200 || !strings.Contains(body, `"code":"node_offline"`) || strings.Contains(body, "live output") {
		t.Fatal(status, body)
	}
}
