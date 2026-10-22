package httpapi_test

import (
	"encoding/json"
	"testing"

	"baton/internal/protocol"
	"baton/internal/store"
)

func TestThreadHTTPModelsAndBrowserCreateContract(t *testing.T) {
	h := newThreadHTTP(t)
	agents := []protocol.RuntimeAgent{
		{AgentType: "pi", Version: "1", Status: "available", DefaultModel: "a", Models: []protocol.RuntimeModel{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}}, Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Steer: true, SwitchModel: true}},
		{AgentType: "kiro", Version: "1", Status: "available", DefaultModel: "a", Models: []protocol.RuntimeModel{{ID: "a", Name: "A"}, {ID: "b", Name: "B"}}, Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true}},
	}
	if _, err := h.repo.SaveRuntimeReport(t.Context(), h.src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: agents}); err != nil {
		t.Fatal(err)
	}
	payload := func(key string) map[string]any {
		return map[string]any{"client_thread_id": key, "agent_type": "pi", "working_directory": "/src/repo", "message": map[string]string{"client_message_id": key + ":first", "content": "hello"}}
	}
	for _, field := range []string{"project_id", "execution_timeout_seconds"} {
		body := payload(field)
		body[field] = 1
		h.post("/threads", body, 400)
	}
	body := payload("nested-model")
	body["message"].(map[string]string)["model"] = "a"
	h.post("/threads", body, 400)
	body = payload("invalid")
	body["model"] = "missing"
	h.post("/threads", body, 422)
	defaultThread := h.create("default-model")
	if defaultThread.Model != "a" || defaultThread.ProjectID != "" || defaultThread.ExecutionTimeoutSeconds != 7200 {
		t.Fatal(defaultThread)
	}
	body = payload("selected")
	body["model"] = "b"
	var selected store.Thread
	if err := json.Unmarshal([]byte(h.post("/threads", body, 201)), &selected); err != nil || selected.Model != "b" {
		t.Fatal(selected, err)
	}
	h.post("/threads", body, 200)
	body["model"] = "a"
	h.post("/threads", body, 409)
	path := "/threads/" + selected.ID + "/messages"
	for _, args := range []map[string]string{
		{"client_message_id": "unknown", "content": "next", "model": "missing"},
		{"client_message_id": "steer-model", "content": "next", "mode": "steer", "model": "b"},
	} {
		h.post(path, args, 422)
	}
	args := map[string]string{"client_message_id": "switch", "content": "next", "model": "a"}
	var message store.ThreadMessage
	if err := json.Unmarshal([]byte(h.post(path, args, 202)), &message); err != nil || message.Model != "a" {
		t.Fatal(message, err)
	}
	h.post(path, args, 202)
	args["model"] = "b"
	h.post(path, args, 409)
	body = payload("fixed")
	body["agent_type"] = "kiro"
	body["model"] = "b"
	var fixed store.Thread
	if err := json.Unmarshal([]byte(h.post("/threads", body, 201)), &fixed); err != nil {
		t.Fatal(err)
	}
	h.post("/threads/"+fixed.ID+"/messages", args, 422)
	_, text := getText(t, h.browser, h.srv.URL+"/api/v1/threads/"+selected.ID)
	var view store.ThreadView
	if err := json.Unmarshal([]byte(text), &view); err != nil || view.Model != "b" || len(view.PendingMessages) != 2 || view.PendingMessages[1].Model != "a" {
		t.Fatal(view, err)
	}
	var count int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM threads`).Scan(&count); err != nil || count != 3 {
		t.Fatal("invalid create persisted", count, err)
	}
}
