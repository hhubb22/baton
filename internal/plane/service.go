package plane

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"baton/internal/identity"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Acceptor interface {
	AcceptTask(context.Context, string, task.Input) (task.Record, error)
}

type Service struct {
	cfg    Config
	pool   *pgxpool.Pool
	client *client
	accept Acceptor
	gate   chan struct{}
	logger *slog.Logger
}

type Result struct {
	Outcome   string   `json:"outcome"`
	Code      string   `json:"code,omitempty"`
	Fields    []string `json:"fields,omitempty"`
	TriggerID string   `json:"trigger_id,omitempty"`
	TaskID    string   `json:"task_id,omitempty"`
}

func New(pool *pgxpool.Pool, cfg Config, accept Acceptor, transport http.RoundTripper, logger *slog.Logger) (*Service, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if pool == nil || accept == nil {
		return nil, errors.New("Plane store is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{cfg: cfg, pool: pool, client: newClient(cfg, transport), accept: accept, gate: make(chan struct{}, 1), logger: logger}, nil
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/json")
	write := func(status int, result Result) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(result)
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		write(http.StatusMethodNotAllowed, Result{Outcome: "rejected", Code: "method_not_allowed"})
		return
	}
	if r.URL.RawQuery != "" {
		write(http.StatusBadRequest, Result{Outcome: "rejected", Code: "invalid_request"})
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		write(http.StatusRequestEntityTooLarge, Result{Outcome: "rejected", Code: "body_too_large"})
		return
	}
	if !verify(s.cfg.Secret, raw, r.Header.Get("X-Plane-Signature")) {
		write(http.StatusUnauthorized, Result{Outcome: "rejected", Code: "invalid_signature"})
		return
	}
	delivery, err := identity.ParseUUID(r.Header.Get("X-Plane-Delivery"))
	if err != nil {
		write(http.StatusBadRequest, Result{Outcome: "rejected", Code: "invalid_delivery"})
		return
	}
	e, err := parseEvent(s.cfg, raw, r.Header.Get("X-Plane-Event"))
	if err != nil {
		write(http.StatusBadRequest, Result{Outcome: "rejected", Code: "invalid_event"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	id, conflict, err := s.receive(ctx, delivery, raw, e)
	if err != nil {
		s.logger.Error("event=plane_inbox_write_failed", "delivery_id", delivery)
		write(http.StatusServiceUnavailable, Result{Outcome: "pending", Code: "unavailable"})
		return
	}
	if conflict {
		write(http.StatusOK, Result{Outcome: "rejected", Code: "delivery_conflict"})
		return
	}
	result, err := s.process(ctx, id, false)
	if err != nil {
		write(http.StatusServiceUnavailable, Result{Outcome: "pending", Code: "unavailable"})
		return
	}
	write(http.StatusOK, result)
}

func (s *Service) process(ctx context.Context, delivery string, dueOnly bool) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	select {
	case s.gate <- struct{}{}:
		defer func() { <-s.gate }()
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return Result{}, err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended(current_schema() || $1, 130))`, s.cfg.WebhookID+s.cfg.ProjectID).Scan(&locked); err != nil || !locked {
		return Result{}, errors.New("Plane integration busy")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(cleanup, `SELECT pg_advisory_unlock(hashtextextended(current_schema() || $1, 130))`, s.cfg.WebhookID+s.cfg.ProjectID); err != nil {
			_ = conn.Hijack().Close(cleanup)
		}
	}()
	var hash, input []byte
	var result Result
	var processed, due bool
	var attempts int
	err = conn.QueryRow(ctx, `SELECT body_hash,event_input,outcome,block_code,block_fields,COALESCE(trigger_id,''),
		processed_at IS NOT NULL,attempts,next_attempt_at <= now() FROM plane_deliveries
		WHERE webhook_id=$1 AND project_id=$2 AND delivery_id=$3`, s.cfg.WebhookID, s.cfg.ProjectID, delivery).Scan(
		&hash, &input, &result.Outcome, &result.Code, &result.Fields, &result.TriggerID, &processed, &attempts, &due)
	if err != nil {
		return Result{}, err
	}
	if processed {
		if result.TriggerID != "" {
			if err := conn.QueryRow(ctx, `SELECT COALESCE(task_id::text,'') FROM plane_triggers WHERE trigger_id=$1`, result.TriggerID).Scan(&result.TaskID); err != nil {
				return Result{}, err
			}
		}
		return result, nil
	}
	if dueOnly && !due {
		return result, nil
	}
	if attempts >= maxAttempts {
		if result.TriggerID != "" {
			recovered, found, err := s.recoverAccepted(ctx, conn, result.TriggerID)
			if err != nil {
				return Result{}, err
			}
			if found {
				return recovered, s.finish(ctx, conn, delivery, recovered)
			}
		}
		result.Outcome, result.Code = "blocked", "retry_exhausted"
		result.Fields = nil
		return result, s.finish(ctx, conn, delivery, result)
	}
	var saved savedEvent
	if err := json.Unmarshal(input, &saved); err != nil {
		return Result{}, err
	}
	attempts++
	if _, err := conn.Exec(ctx, `UPDATE plane_deliveries SET attempts=$4,next_attempt_at=now()+$5 * interval '1 millisecond'
		WHERE webhook_id=$1 AND project_id=$2 AND delivery_id=$3`, s.cfg.WebhookID, s.cfg.ProjectID, delivery,
		attempts, (attemptTimeout + retryDelay(attempts)).Milliseconds()); err != nil {
		return Result{}, err
	}
	result, err = s.decide(ctx, conn, saved.event(), result.TriggerID, hash)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		delay := retryDelay(attempts)
		if attempts >= maxAttempts {
			delay = 0
		}
		_, _ = conn.Exec(cleanup, `UPDATE plane_deliveries SET last_error_code='unavailable',next_attempt_at=now()+$4 * interval '1 millisecond'
			WHERE webhook_id=$1 AND project_id=$2 AND delivery_id=$3`, s.cfg.WebhookID, s.cfg.ProjectID, delivery, delay.Milliseconds())
		return Result{}, err
	}
	return result, s.finish(ctx, conn, delivery, result)
}

func equalHash(a, b []byte) bool {
	return string(a) == string(b)
}

func nonNil(fields []string) []string {
	if fields == nil {
		return []string{}
	}
	return fields
}

func (s *Service) decide(ctx context.Context, conn *pgxpool.Conn, e event, pendingID string, hash []byte) (Result, error) {
	if e.Event == "issue_comment" || e.Data.ExternalSource == "baton" {
		return Result{Outcome: "ignored", Code: "non_trigger_event"}, nil
	}
	if e.Action == "created" {
		return Result{Outcome: "linked"}, nil
	}
	if e.Activity.Actor.ID == "" || e.Activity.Actor.Email == "" {
		return Result{Outcome: "blocked", Code: "missing_fields", Fields: []string{"activity.actor"}}, nil
	}
	if e.Data.UpdatedAt.IsZero() || e.Data.State.ID == "" {
		return Result{Outcome: "blocked", Code: "missing_fields", Fields: []string{"data.updated_at", "data.state.id"}}, nil
	}
	// An acceptance may have committed before the inbox acknowledgement was saved.
	// Reconcile that fact without calling AcceptTask again after conditions changed.
	if pendingID != "" {
		if recovered, found, err := s.recoverAccepted(ctx, conn, pendingID); err != nil || found {
			return recovered, err
		}
	}
	cur, group, approved, err := s.client.current(ctx, e.Data.ID)
	if err != nil {
		return Result{}, err
	}
	if cur.ExternalSource == "baton" {
		return Result{Outcome: "ignored", Code: "baton_source"}, nil
	}
	if group != "started" || cur.ArchivedAt != nil || cur.DeletedAt != nil || cur.IsDraft {
		return Result{Outcome: "blocked", Code: "not_executable"}, nil
	}
	if e.Data.UpdatedAt.After(cur.UpdatedAt) || cur.UpdatedBy != e.Activity.Actor.ID || cur.State != e.Data.State.ID {
		return Result{Outcome: "blocked", Code: "stale_event"}, nil
	}
	round, err := s.client.round(ctx, cur)
	if err != nil {
		return Result{}, err
	}
	if e.Activity.Field == "state" {
		for i := 0; i < 20 && (round.ID == "" || round.NewIdentifier != cur.State); i++ {
			select {
			case <-ctx.Done():
				return Result{}, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
			round, err = s.client.round(ctx, cur)
			if err != nil {
				return Result{}, err
			}
		}
		if round.ID == "" || round.NewIdentifier != cur.State {
			return Result{}, errors.New("Plane state activity not yet visible")
		}
	}
	if round.ID == "" {
		return Result{Outcome: "blocked", Code: "missing_state_trigger"}, nil
	}
	if _, err := identity.ParseUUID(round.ID); err != nil || round.CreatedAt.IsZero() || round.Epoch <= 0 || round.NewIdentifier != cur.State || e.Data.UpdatedAt.Unix() < int64(round.Epoch) {
		return Result{Outcome: "blocked", Code: "stale_event"}, nil
	}
	if _, err := identity.ParseUUID(round.Actor); err != nil {
		return Result{Outcome: "blocked", Code: "missing_fields", Fields: []string{"state_activity.actor"}}, nil
	}
	// updated_at also changes in Plane's asynchronous activity job. The persisted
	// state activity, not that mutable timestamp or a delivery UUID, defines a round.
	id := triggerID(s.cfg, cur.ID, round.ID)
	if _, err := conn.Exec(ctx, `INSERT INTO plane_triggers(trigger_id,webhook_id,project_id,issue_id,round_at,actor_id,state_activity_id)
		VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, id, s.cfg.WebhookID, s.cfg.ProjectID, cur.ID, round.CreatedAt, round.Actor, round.ID); err != nil {
		return Result{}, err
	}
	var input []byte
	var employeeID, actorID, taskID string
	if err := conn.QueryRow(ctx, `SELECT COALESCE(employee_id::text,''),actor_id::text,task_input,COALESCE(task_id::text,'') FROM plane_triggers WHERE trigger_id=$1`, id).Scan(&employeeID, &actorID, &input, &taskID); err != nil {
		return Result{}, err
	}
	if taskID != "" {
		return Result{Outcome: "accepted", TriggerID: id, TaskID: taskID}, nil
	}
	block := func(code string, fields ...string) (Result, error) {
		_, err := conn.Exec(ctx, `UPDATE plane_triggers SET block_code=$2,block_fields=$3 WHERE trigger_id=$1`, id, code, nonNil(fields))
		return Result{Outcome: "blocked", Code: code, Fields: fields, TriggerID: id}, err
	}
	var actor *Actor
	for i := range s.cfg.Actors {
		a := &s.cfg.Actors[i]
		if a.UserID == e.Activity.Actor.ID && strings.EqualFold(a.Email, e.Activity.Actor.Email) {
			actor = a
		}
	}
	if actor == nil {
		return block("unmapped_actor", "activity.actor")
	}
	if actorID != actor.UserID || (employeeID != "" && employeeID != actor.EmployeeID) {
		return block("trigger_actor_mismatch", "activity.actor")
	}
	if !approved {
		return block("design_not_approved", "design-approved")
	}
	var in task.Input
	if len(input) == 0 {
		in = actor.Task
		in.RequestID = id
		in.Description = description(cur)
		var missing []string
		for _, field := range []struct {
			name  string
			value *string
		}{
			{"target_node_id", in.TargetNodeID}, {"agent_type", in.AgentType}, {"working_directory", in.WorkingDirectory}, {"authorization_scope", in.AuthorizationScope}, {"expected_outputs", in.ExpectedOutputs},
		} {
			if field.value == nil || strings.TrimSpace(*field.value) == "" {
				missing = append(missing, field.name)
			}
		}
		if in.Description == "" {
			missing = append(missing, "description")
		}
		if len(missing) != 0 {
			return block("missing_fields", missing...)
		}
		if err := task.Validate(in); err != nil {
			var rejection *task.Rejection
			if errors.As(err, &rejection) {
				return block(rejection.Code, rejection.Fields...)
			}
			return Result{}, err
		}
		// Freeze the exact request before crossing the AcceptTask transaction boundary.
		input, err = json.Marshal(in)
		if err != nil {
			return Result{}, err
		}
		var exists bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM employees WHERE id=$1)`, actor.EmployeeID).Scan(&exists); err != nil {
			return Result{}, err
		}
		if !exists {
			return block("unmapped_employee", "employee_id")
		}
		if _, err := conn.Exec(ctx, `UPDATE plane_triggers SET employee_id=$2,task_input=$3 WHERE trigger_id=$1`, id, actor.EmployeeID, input); err != nil {
			return Result{}, err
		}
		employeeID = actor.EmployeeID
	} else if err := json.Unmarshal(input, &in); err != nil {
		return Result{}, err
	}
	if _, err := conn.Exec(ctx, `UPDATE plane_deliveries SET trigger_id=$4 WHERE webhook_id=$1 AND project_id=$2 AND body_hash=$3`, s.cfg.WebhookID, s.cfg.ProjectID, hash, id); err != nil {
		return Result{}, err
	}
	rec, err := s.accept.AcceptTask(ctx, employeeID, in)
	if err != nil {
		var rejection *task.Rejection
		if errors.As(err, &rejection) {
			return block(rejection.Code, rejection.Fields...)
		}
		return Result{}, err
	}
	if _, err := conn.Exec(ctx, `UPDATE plane_triggers SET task_id=$2,block_code='',block_fields='{}' WHERE trigger_id=$1`, id, rec.TaskID); err != nil {
		return Result{}, err
	}
	return Result{Outcome: "accepted", TriggerID: id, TaskID: rec.TaskID}, nil
}

func (s *Service) recoverAccepted(ctx context.Context, conn *pgxpool.Conn, id string) (Result, bool, error) {
	var input, hash []byte
	var taskID string
	err := conn.QueryRow(ctx, `SELECT p.task_input,t.request_hash,t.id::text FROM plane_triggers p
		JOIN tasks t ON t.employee_id=p.employee_id AND t.request_id=p.trigger_id WHERE p.trigger_id=$1`, id).Scan(&input, &hash, &taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, false, nil
	}
	if err != nil {
		return Result{}, false, err
	}
	var in task.Input
	if err := json.Unmarshal(input, &in); err != nil {
		return Result{}, false, err
	}
	prepared, err := task.Prepare(in)
	if err != nil {
		return Result{}, false, err
	}
	if !equalHash(prepared.Hash, hash) {
		return Result{}, false, nil
	}
	_, err = conn.Exec(ctx, `UPDATE plane_triggers SET task_id=$2,block_code='',block_fields='{}' WHERE trigger_id=$1`, id, taskID)
	return Result{Outcome: "accepted", TriggerID: id, TaskID: taskID}, true, err
}
