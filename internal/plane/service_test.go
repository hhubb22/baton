package plane

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/store"
	"baton/internal/task"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	t       *testing.T
	pool    *pgxpool.Pool
	repo    *store.Store
	cfg     Config
	svc     *Service
	mu      sync.Mutex
	cur     issue
	round   activity
	apiCode int
	reads   int
}

func ptr[T any](x T) *T { return &x }

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	f := &fixture{t: t, pool: dbtest.Open(t)}
	f.repo = store.New(f.pool)
	emp, err := admin.CreateLocal(ctx, f.pool, "plane-user", "Plane", "correct-horse-battery-9")
	if err != nil {
		t.Fatal(err)
	}
	_, token, _, err := f.repo.IssueEnrollment(ctx, emp.ID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	n, err := f.repo.Register(ctx, store.RegisterInput{Token: token, DisplayName: "Plane node", System: node.SystemLinux, Role: node.RolePC, Capabilities: []string{"pi", "start"}, CredentialTTL: time.Hour}, signer)
	if err != nil {
		t.Fatal(err)
	}
	f.cfg = Config{WorkspaceID: uuid.NewString(), WorkspaceSlug: "test", ProjectID: uuid.NewString(), WebhookID: uuid.NewString(), ApprovalLabelID: uuid.NewString(), APIKey: "test-api-key", Secret: "test-webhook-secret",
		Actors: []Actor{{UserID: uuid.NewString(), Email: "user@example.test", EmployeeID: emp.ID, Task: task.Input{
			TargetNodeID: ptr(n.NodeID), AgentType: ptr("pi"), WorkingDirectory: ptr("/work"), AuthorizationScope: ptr("read-only test"), ExpectedOutputs: ptr("summary"),
		}}},
	}
	f.cur = issue{ID: uuid.NewString(), Project: f.cfg.ProjectID, Workspace: f.cfg.WorkspaceID, Name: "调查", DescriptionHTML: "<p>查验 &amp; 记录</p>", State: uuid.NewString(), Labels: []string{f.cfg.ApprovalLabelID}, UpdatedAt: time.Now().UTC().Truncate(time.Microsecond), UpdatedBy: f.cfg.Actors[0].UserID}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.reads++
		if r.Header.Get("X-API-Key") != f.cfg.APIKey {
			t.Error("missing API key")
		}
		if f.apiCode != 0 {
			w.WriteHeader(f.apiCode)
			fmt.Fprint(w, "secret response must not leak")
			return
		}
		var value any
		switch {
		case r.URL.Path == "/api/instances/":
			value = map[string]any{"instance": map[string]any{"current_version": "1.4.2"}}
		case strings.HasSuffix(r.URL.Path, "/states/"):
			value = map[string]any{"results": []state{{ID: f.cur.State, Group: "started"}}, "next_page_results": false}
		case strings.HasSuffix(r.URL.Path, "/labels/"):
			value = map[string]any{"results": []label{{ID: f.cfg.ApprovalLabelID, Name: "design-approved"}}, "next_page_results": false}
		case strings.HasSuffix(r.URL.Path, "/activities/"):
			rows := []activity{}
			if f.round.ID != "" {
				rows = append(rows, f.round)
			}
			value = map[string]any{"results": rows, "next_page_results": false}
		case strings.HasSuffix(r.URL.Path, "/issues/"+f.cur.ID+"/"):
			value = f.cur
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	t.Cleanup(api.Close)
	f.cfg.URL = api.URL
	f.restart(f.repo)
	return f
}

func (f *fixture) restart(a Acceptor) {
	f.t.Helper()
	var err error
	f.svc, err = New(f.pool, f.cfg, a, nil)
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) event(action, field string) event {
	f.mu.Lock()
	defer f.mu.Unlock()
	if action == "updated" && field == "state" && !f.round.CreatedAt.Equal(f.cur.UpdatedAt) {
		f.round = activity{ID: uuid.NewString(), Issue: f.cur.ID, Project: f.cur.Project, Workspace: f.cur.Workspace,
			Field: "state", Actor: f.cur.UpdatedBy, NewIdentifier: f.cur.State, CreatedAt: f.cur.UpdatedAt, Epoch: float64(f.cur.UpdatedAt.Unix())}
	}
	e := event{Event: "issue", Action: action, WebhookID: f.cfg.WebhookID, WorkspaceID: f.cfg.WorkspaceID, WorkspaceSlug: f.cfg.WorkspaceSlug}
	e.Data.ID = f.cur.ID
	e.Data.Project = f.cur.Project
	e.Data.State = state{ID: f.cur.State, Group: "started"}
	e.Data.UpdatedAt = f.cur.UpdatedAt
	e.Activity.Field = field
	e.Activity.Actor.ID = f.cfg.Actors[0].UserID
	e.Activity.Actor.Email = f.cfg.Actors[0].Email
	return e
}

func (f *fixture) change(fn func(*issue)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cur.UpdatedAt = f.cur.UpdatedAt.Add(time.Second)
	fn(&f.cur)
}

func signedRequest(cfg Config, raw []byte, delivery, eventName string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, Path, bytes.NewReader(raw))
	m := hmac.New(sha256.New, []byte(cfg.Secret))
	m.Write(raw)
	r.Header.Set("X-Plane-Signature", hex.EncodeToString(m.Sum(nil)))
	r.Header.Set("X-Plane-Delivery", delivery)
	r.Header.Set("X-Plane-Event", eventName)
	return r
}

func (f *fixture) send(e event, delivery string) (int, Result) {
	f.t.Helper()
	raw, err := json.Marshal(e)
	if err != nil {
		f.t.Fatal(err)
	}
	w := httptest.NewRecorder()
	f.svc.ServeHTTP(w, signedRequest(f.cfg, raw, delivery, e.Event))
	var res Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		f.t.Fatal(err)
	}
	return w.Code, res
}

func (f *fixture) assertTasks(want int) {
	f.t.Helper()
	for _, table := range []string{"tasks", "executions", "dispatch_outbox", "request_tombstones"} {
		var n int
		if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
			f.t.Fatal(err)
		}
		if n != want {
			f.t.Fatalf("%s=%d want %d", table, n, want)
		}
	}
}

func TestLifecycleAndReplay(t *testing.T) {
	f := newFixture(t)
	if code, res := f.send(f.event("created", ""), uuid.NewString()); code != 200 || res.Outcome != "linked" {
		t.Fatalf("create: %d %+v", code, res)
	}
	f.assertTasks(0)
	f.change(func(i *issue) { i.Labels = nil })
	stateEvent := f.event("updated", "state")
	if _, res := f.send(stateEvent, uuid.NewString()); res.Code != "design_not_approved" {
		t.Fatalf("approval: %+v", res)
	}
	f.assertTasks(0)
	f.change(func(i *issue) { i.Labels = []string{f.cfg.ApprovalLabelID} })
	e := f.event("updated", "labels")
	delivery := uuid.NewString()
	_, first := f.send(e, delivery)
	if first.Outcome != "accepted" || first.TaskID == "" {
		t.Fatalf("accept: %+v", first)
	}
	f.assertTasks(1)
	f.mu.Lock()
	reads := f.reads
	f.mu.Unlock()
	for _, id := range []string{delivery, uuid.NewString()} {
		if _, res := f.send(e, id); res.TaskID != first.TaskID {
			t.Fatalf("duplicate: %+v", res)
		}
	}
	f.mu.Lock()
	after := f.reads
	f.mu.Unlock()
	if after != reads {
		t.Fatal("duplicate fetched current facts")
	}
	f.restart(f.repo)
	f.change(func(i *issue) { i.Name = "后续编辑" })
	if _, res := f.send(f.event("updated", "name"), uuid.NewString()); res.TaskID != first.TaskID {
		t.Fatalf("same round: %+v", res)
	}
	comment := f.event("created", "")
	comment.Event = "issue_comment"
	comment.Data.Issue = comment.Data.ID
	comment.Data.ID = uuid.NewString()
	comment.Data.ExternalSource = "baton"
	if _, res := f.send(comment, uuid.NewString()); res.Outcome != "ignored" {
		t.Fatalf("writeback: %+v", res)
	}
	f.assertTasks(1)
	f.change(func(*issue) {})
	_, next := f.send(f.event("updated", "state"), uuid.NewString())
	if next.Outcome != "accepted" || next.TaskID == first.TaskID || next.TriggerID == first.TriggerID {
		t.Fatalf("new round: %+v", next)
	}
	f.assertTasks(2)
	if _, res := f.send(stateEvent, uuid.NewString()); res.Code != "design_not_approved" {
		t.Fatalf("original blocked receipt changed: %+v", res)
	}
	f.assertTasks(2)
	var desc string
	if err := f.pool.QueryRow(context.Background(), `SELECT description FROM tasks WHERE id=$1`, first.TaskID).Scan(&desc); err != nil {
		t.Fatal(err)
	}
	if desc != "调查\n\n查验 & 记录" {
		t.Fatalf("description %q", desc)
	}
}

func TestGates(t *testing.T) {
	for _, test := range []struct {
		name, code string
		mutate     func(*fixture, *event)
	}{
		{"unmapped", "unmapped_actor", func(f *fixture, e *event) {
			e.Activity.Actor.ID = uuid.NewString()
			f.cur.UpdatedBy = e.Activity.Actor.ID
			f.round.Actor = e.Activity.Actor.ID
		}},
		{"email", "unmapped_actor", func(f *fixture, e *event) { e.Activity.Actor.Email = "wrong@example.test" }},
		{"missing actor", "missing_fields", func(f *fixture, e *event) { e.Activity.Actor.ID = "" }},
		{"missing timestamp", "missing_fields", func(f *fixture, e *event) { e.Data.UpdatedAt = time.Time{} }},
		{"missing target", "missing_fields", func(f *fixture, e *event) { f.cfg.Actors[0].Task.TargetNodeID = nil; f.restart(f.repo) }},
		{"missing agent", "missing_fields", func(f *fixture, e *event) { f.cfg.Actors[0].Task.AgentType = nil; f.restart(f.repo) }},
		{"empty description", "missing_fields", func(f *fixture, e *event) { f.cur.DescriptionHTML = "<p> </p>" }},
		{"unapproved", "design_not_approved", func(f *fixture, e *event) { f.cur.Labels = nil }},
		{"missing approval mapping", "design_not_approved", func(f *fixture, e *event) { f.cfg.ApprovalLabelID = ""; f.restart(f.repo) }},
		{"stale", "stale_event", func(f *fixture, e *event) { e.Data.UpdatedAt = e.Data.UpdatedAt.Add(-time.Second) }},
		{"state changed", "stale_event", func(f *fixture, e *event) { e.Data.State.ID = uuid.NewString() }},
		{"archived", "not_executable", func(f *fixture, e *event) { f.cur.ArchivedAt = ptr(time.Now()) }},
		{"draft", "not_executable", func(f *fixture, e *event) { f.cur.IsDraft = true }},
		{"not state transition", "missing_state_trigger", func(f *fixture, e *event) { e.Activity.Field = "name"; f.round = activity{} }},
		{"baton issue", "non_trigger_event", func(f *fixture, e *event) { e.Data.ExternalSource = "baton" }},
		{"wrong owner", "forbidden", func(f *fixture, e *event) {
			other, err := admin.CreateLocal(context.Background(), f.pool, "other", "Other", "correct-horse-battery-9")
			if err != nil {
				t.Fatal(err)
			}
			f.cfg.Actors[0].EmployeeID = other.ID
			f.restart(f.repo)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			e := f.event("updated", "state")
			test.mutate(f, &e)
			status, res := f.send(e, uuid.NewString())
			if status != 200 || res.Code != test.code {
				t.Fatalf("%d %+v want %s", status, res, test.code)
			}
			f.assertTasks(0)
			var saved string
			if err := f.pool.QueryRow(context.Background(), `SELECT block_code FROM plane_deliveries`).Scan(&saved); err != nil || saved != test.code {
				t.Fatalf("block not persisted: %s %v", saved, err)
			}
		})
	}
}

func TestInvalidTransportAndScope(t *testing.T) {
	f := newFixture(t)
	for _, name := range []string{"signature", "body", "delivery", "header", "project", "workspace", "webhook", "json", "oversize", "method", "query"} {
		t.Run(name, func(t *testing.T) {
			e := f.event("updated", "state")
			switch name {
			case "project":
				e.Data.Project = uuid.NewString()
			case "workspace":
				e.WorkspaceID = uuid.NewString()
			case "webhook":
				e.WebhookID = uuid.NewString()
			}
			raw, _ := json.Marshal(e)
			if name == "json" {
				raw = []byte("{")
			}
			if name == "oversize" {
				raw = bytes.Repeat([]byte("x"), (1<<20)+1)
			}
			r := signedRequest(f.cfg, raw, uuid.NewString(), e.Event)
			switch name {
			case "signature":
				r.Header.Set("X-Plane-Signature", strings.Repeat("0", 64))
			case "body":
				r.Body = ioBody([]byte("{}"))
			case "delivery":
				r.Header.Del("X-Plane-Delivery")
			case "header":
				r.Header.Set("X-Plane-Event", "issue_comment")
			case "method":
				r.Method = "GET"
			case "query":
				r.URL.RawQuery = "token=x"
			}
			w := httptest.NewRecorder()
			f.svc.ServeHTTP(w, r)
			if w.Code < 400 || w.Code >= 500 {
				t.Fatalf("status %d", w.Code)
			}
		})
	}
	f.assertTasks(0)
	var n int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM plane_deliveries`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("untrusted receipt persisted %d %v", n, err)
	}
}

func ioBody(b []byte) *bodyReader { return &bodyReader{bytes.NewReader(b)} }

type bodyReader struct{ *bytes.Reader }

func (*bodyReader) Close() error { return nil }

type lostAcceptance struct{ repo *store.Store }

func (a lostAcceptance) AcceptTask(ctx context.Context, id string, in task.Input) (task.Record, error) {
	rec, err := a.repo.AcceptTask(ctx, id, in)
	if err != nil {
		return rec, err
	}
	return task.Record{}, errors.New("lost acceptance response")
}

func TestAcceptanceCrashRecoveryAndFailureRetry(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprint(committed), func(t *testing.T) {
			f := newFixture(t)
			e := f.event("updated", "state")
			delivery := uuid.NewString()
			if committed {
				f.restart(lostAcceptance{f.repo})
			} else {
				f.repo.SetTaskCommitHook(func(context.Context) error { return errors.New("database fault") })
			}
			if status, _ := f.send(e, delivery); status != 503 {
				t.Fatalf("status %d", status)
			}
			if committed {
				f.assertTasks(1)
				f.change(func(i *issue) { i.Labels = nil })
			} else {
				f.assertTasks(0)
			}
			f.repo.SetTaskCommitHook(nil)
			f.restart(f.repo)
			status, res := f.send(e, delivery)
			if status != 200 || res.Outcome != "accepted" {
				t.Fatalf("retry %d %+v", status, res)
			}
			f.assertTasks(1)
		})
	}
}

func TestConcurrentDeliveries(t *testing.T) {
	f := newFixture(t)
	e := f.event("updated", "state")
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			status, res := f.send(e, uuid.NewString())
			if status != 200 || res.Outcome != "accepted" {
				t.Errorf("%d %+v", status, res)
			}
		})
	}
	wg.Wait()
	f.assertTasks(1)
}

func TestAPIUnavailableDoesNotConsumeDelivery(t *testing.T) {
	f := newFixture(t)
	e := f.event("updated", "state")
	delivery := uuid.NewString()
	f.apiCode = 429
	if status, _ := f.send(e, delivery); status != 503 {
		t.Fatalf("status %d", status)
	}
	f.assertTasks(0)
	f.apiCode = 0
	if status, res := f.send(e, delivery); status != 200 || res.Outcome != "accepted" {
		t.Fatalf("%d %+v", status, res)
	}
	f.assertTasks(1)
}

func TestDelayedStateActivityCanBeRetried(t *testing.T) {
	f := newFixture(t)
	e := f.event("updated", "state")
	round := f.round
	f.round = activity{}
	delivery := uuid.NewString()
	if status, result := f.send(e, delivery); status != http.StatusServiceUnavailable || result.Outcome != "pending" {
		t.Fatalf("state history not yet ready: %d %+v", status, result)
	}
	f.assertTasks(0)
	f.round = round
	if status, result := f.send(e, delivery); status != http.StatusOK || result.Outcome != "accepted" {
		t.Fatalf("state history retry: %d %+v", status, result)
	}
	f.assertTasks(1)
}
