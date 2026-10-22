package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"baton/internal/protocol"
	"baton/internal/store"
)

func TestThreadHTTPModelFailureIsVisibleAndQueueContinues(t *testing.T) {
	h := newThreadHTTP(t)
	if _, err := h.repo.SaveRuntimeReport(t.Context(), h.src, protocol.RuntimeReport{
		Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}},
		Agents: []protocol.RuntimeAgent{{AgentType: "pi", Version: "1", Status: "available", DefaultModel: "a",
			Models:       []protocol.RuntimeModel{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}},
			Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, SwitchModel: true}}},
	}); err != nil {
		t.Fatal(err)
	}
	v := h.create("model-failure")
	h.report(v.ID, 1, "thread.opened", 0, "", "")
	h.report(v.ID, 2, "turn.started", 1, "model-failure:first", "")
	h.report(v.ID, 3, "message.sent", 1, "model-failure:first", "")
	path := "/threads/" + v.ID
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "failed", Content: "switch", Model: "b"}, 202)
	h.post(path+"/messages", store.ThreadMessageInput{ClientMessageID: "next", Content: "continue"}, 202)
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: threadHTTPID(t), WorkerSeq: 4, Kind: "turn.ended", WorkerTurnSeq: 1, Reason: "completed", QueueEmpty: false}
	if ack, err := h.repo.SaveThreadReport(t.Context(), h.src, r); err != nil || !ack.OK {
		t.Fatal(ack, err)
	}
	const reason = "model selection failed: model unavailable"
	h.report(v.ID, 5, "message.withdrawn", 0, "failed", reason)
	status, text := getText(t, h.browser, h.srv.URL+"/api/v1"+path)
	var view store.ThreadView
	if err := json.Unmarshal([]byte(text), &view); err != nil || status != http.StatusOK || view.Status != "idle" || view.Model != "a" || len(view.FailedMessages) != 1 || view.FailedMessages[0].StatusReason != reason || len(view.PendingMessages) != 1 {
		t.Fatal(status, text, err)
	}
	h.report(v.ID, 6, "turn.started", 2, "next", "")
	h.report(v.ID, 7, "message.sent", 2, "next", "")
	status, text = getText(t, h.browser, h.srv.URL+"/api/v1"+path)
	if err := json.Unmarshal([]byte(text), &view); err != nil || status != http.StatusOK || view.Status != "running" || view.CurrentTurn == nil || view.CurrentTurn.WorkerTurnSeq != 2 || view.CurrentTurn.Model != "a" {
		t.Fatal(status, text, err)
	}
}
