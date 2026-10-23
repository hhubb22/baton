package httpapi_test

import (
	"baton/internal/auth"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestWebSessionCSRFRestoresAcrossTabs(t *testing.T) {
	h := newThreadHTTP(t)
	parsed, _ := url.Parse(h.srv.URL)
	token := ""
	for _, cookie := range h.browser.jar.Cookies(parsed) {
		if cookie.Name == auth.SessionCookieName {
			token = cookie.Value
		}
	}
	if token == "" {
		t.Fatal("missing session cookie")
	}
	for range 3 {
		status, body := getText(t, h.browser, h.srv.URL+"/api/v1/me")
		if status != 200 || mustCSRF(t, body) != h.csrf || strings.Contains(body, token) {
			t.Fatal(status, body)
		}
	}
	status, body := projectRequest(t, h.browser, "POST", h.srv.URL+"/api/v1/projects", h.csrf, map[string]string{"title": "restored csrf"})
	if status != 201 {
		t.Fatal(status, body)
	}
}

func TestWebNodesEnrollmentAndRealRuntimeReport(t *testing.T) {
	h := newThreadHTTP(t)
	e := issueEnrollment(t, h.browser, h.srv.URL, h.csrf)
	url := h.srv.URL + "/api/v1/node-enrollments/" + e.EnrollmentID
	status, body := getText(t, h.browser, url)
	var v store.EnrollmentView
	if json.Unmarshal([]byte(body), &v) != nil || status != 200 || v.State != "pending" || v.DeviceID != nil || v.ExpiresInMS <= 0 || strings.Contains(body, e.EnrollmentToken) {
		t.Fatal(status, body)
	}
	status, body, _ = postJSON(t, h.browser, h.srv.URL+"/api/v1/nodes/register", "", "", registerBody(e.EnrollmentToken, "Joined", "pc", []string{"pi"}))
	if status != 200 {
		t.Fatal(status, body)
	}
	var ident node.Identity
	if err := json.Unmarshal([]byte(body), &ident); err != nil {
		t.Fatal(err)
	}
	_, body = getText(t, h.browser, url)
	if json.Unmarshal([]byte(body), &v) != nil || v.State != "used" || v.DeviceID == nil {
		t.Fatal(body)
	}
	if _, err := h.repo.OwnEnrollment(t.Context(), threadHTTPID(t), e.EnrollmentID); err != store.ErrNotFound {
		t.Fatal(err)
	}
	status, body = getText(t, h.browser, h.srv.URL+"/api/v1/nodes/"+*v.DeviceID)
	if status != 200 || !strings.Contains(body, `"runtime_report":null`) {
		t.Fatal(status, body)
	}
	report := protocol.RuntimeReport{BatondVersion: "actual-build", User: "actual-user", Exec: protocol.RuntimeExec{Shell: "sh"}}
	if _, err := h.repo.SaveRuntimeReport(t.Context(), h.src, report); err != nil {
		t.Fatal(err)
	}
	status, body = getText(t, h.browser, h.srv.URL+"/api/v1/nodes/"+h.src.NodeID)
	var n struct {
		Report       *protocol.RuntimeReport `json:"runtime_report"`
		RegisteredAt time.Time               `json:"registered_at"`
	}
	if json.Unmarshal([]byte(body), &n) != nil || status != 200 || n.Report == nil || n.Report.User != report.User || n.Report.BatondVersion != report.BatondVersion || n.RegisteredAt.IsZero() {
		t.Fatal(status, body)
	}
	if err := h.repo.SyncNode(t.Context(), h.owner, *v.DeviceID, "unknown", "Joined", "linux", "", nil); err == nil {
		t.Fatal("synced unknown connection")
	}
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: h.owner, NodeID: ident.NodeID, CredentialID: ident.Credential.ID, ConnID: threadHTTPID(t), Incarnation: threadHTTPID(t)}
	if err := h.repo.ConnectNode(t.Context(), src); err != nil {
		t.Fatal(err)
	}
	if err := h.repo.SyncNode(t.Context(), h.owner, src.NodeID, src.ConnID, ident.DisplayName, ident.System, "", ident.Capabilities); err != nil {
		t.Fatal(err)
	}
	_, body = getText(t, h.browser, url)
	if !strings.Contains(body, `"state":"connected"`) {
		t.Fatal(body)
	}
	if err := h.repo.MarkOffline(t.Context(), src.NodeID, src.ConnID, time.Now()); err != nil {
		t.Fatal(err)
	}
	// 注册已关联；连通状态只由真实 presence/sync 记录决定。
	if _, err := h.pool.Exec(t.Context(), `UPDATE node_enrollments SET expires_at=now()-interval '1 second',created_at=now()-interval '1 minute' WHERE id=$1`, e.EnrollmentID); err != nil {
		t.Fatal(err)
	}
	_, body = getText(t, h.browser, url)
	if !strings.Contains(body, `"state":"used"`) {
		t.Fatal(body)
	}
}

func TestWebProjectIdempotencyAndMemoryRevisionTitles(t *testing.T) {
	h := newThreadHTTP(t)
	in := map[string]string{"client_project_id": threadHTTPID(t), "title": "original", "goal": "goal"}
	var p projectagent.Project
	body := h.post("/projects", in, 201)
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatal(err)
	}
	retry := h.post("/projects", in, 201)
	var again projectagent.Project
	_ = json.Unmarshal([]byte(retry), &again)
	if p.ID != again.ID {
		t.Fatal("duplicate project")
	}
	in["goal"] = "different"
	h.post("/projects", in, 409)
	base := h.srv.URL + "/api/v1/projects/" + p.ID + "/memory/" + threadHTTPID(t)
	for i, title := range []string{"first title", "second title"} {
		status, body := projectRequest(t, h.browser, "PUT", base, h.csrf, map[string]any{"title": title, "content": title + " body", "expected_revision": i})
		if status != 200 {
			t.Fatal(status, body)
		}
	}
	status, body := getText(t, h.browser, base+"/revisions?limit=1")
	var page struct {
		Revisions []store.MemoryRevision `json:"revisions"`
		Next      int64                  `json:"next_after_revision"`
	}
	if json.Unmarshal([]byte(body), &page) != nil || status != 200 || len(page.Revisions) != 1 || page.Next != 1 || page.Revisions[0].Title == nil || *page.Revisions[0].Title != "first title" || page.Revisions[0].CreatedAt.IsZero() {
		t.Fatal(status, body)
	}
	status, body = getText(t, h.browser, base+"/revisions?after_revision=1")
	if json.Unmarshal([]byte(body), &page) != nil || status != 200 || len(page.Revisions) != 1 || *page.Revisions[0].Title != "second title" {
		t.Fatal(status, body)
	}
}
