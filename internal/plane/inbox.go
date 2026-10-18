package plane

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxAttempts    = 8
	attemptTimeout = 45 * time.Second
	initialDelay   = 5 * time.Second
)

type savedEvent struct {
	Event          string    `json:"event"`
	Action         string    `json:"action"`
	IssueID        string    `json:"issue_id"`
	ActorID        string    `json:"actor_id"`
	ActorEmail     string    `json:"actor_email"`
	StateID        string    `json:"state_id"`
	UpdatedAt      time.Time `json:"updated_at"`
	ExternalSource string    `json:"external_source"`
	Field          string    `json:"field"`
}

func (e savedEvent) event() event {
	var out event
	out.Event, out.Action = e.Event, e.Action
	out.Data.ID, out.Data.Issue = e.IssueID, e.IssueID
	out.Data.State.ID, out.Data.UpdatedAt = e.StateID, e.UpdatedAt
	out.Data.ExternalSource = e.ExternalSource
	out.Activity.Field = e.Field
	out.Activity.Actor.ID, out.Activity.Actor.Email = e.ActorID, e.ActorEmail
	return out
}

func (s *Service) receive(ctx context.Context, delivery string, raw []byte, e event) (string, bool, error) {
	input, err := json.Marshal(savedEvent{Event: e.Event, Action: e.Action, IssueID: e.issueID(),
		ActorID: e.Activity.Actor.ID, ActorEmail: e.Activity.Actor.Email, StateID: e.Data.State.ID,
		UpdatedAt: e.Data.UpdatedAt, ExternalSource: e.Data.ExternalSource, Field: e.Activity.Field})
	if err != nil {
		return "", false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, `INSERT INTO plane_issues(webhook_id,project_id,issue_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
		s.cfg.WebhookID, s.cfg.ProjectID, e.issueID()); err != nil {
		return "", false, err
	}
	hash := sha256.Sum256(raw)
	if _, err := tx.Exec(ctx, `INSERT INTO plane_deliveries(webhook_id,project_id,delivery_id,body_hash,issue_id,event_input)
		VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, s.cfg.WebhookID, s.cfg.ProjectID, delivery, hash[:], e.issueID(), input); err != nil {
		return "", false, err
	}
	var id string
	var savedHash []byte
	if err := tx.QueryRow(ctx, `SELECT delivery_id::text,body_hash FROM plane_deliveries
		WHERE webhook_id=$1 AND project_id=$2 AND (delivery_id=$3 OR body_hash=$4)
		ORDER BY delivery_id=$3 DESC LIMIT 1`, s.cfg.WebhookID, s.cfg.ProjectID, delivery, hash[:]).Scan(&id, &savedHash); err != nil {
		return "", false, err
	}
	if !equalHash(savedHash, hash[:]) {
		return "", true, nil
	}
	return id, false, tx.Commit(ctx)
}

func (s *Service) finish(ctx context.Context, conn *pgxpool.Conn, delivery string, result Result) error {
	_, err := conn.Exec(ctx, `UPDATE plane_deliveries SET outcome=$4,block_code=$5,block_fields=$6,
		trigger_id=NULLIF($7,''),processed_at=now() WHERE webhook_id=$1 AND project_id=$2 AND delivery_id=$3`,
		s.cfg.WebhookID, s.cfg.ProjectID, delivery, result.Outcome, result.Code, nonNil(result.Fields), result.TriggerID)
	return err
}

func retryDelay(attempt int) time.Duration {
	return min(initialDelay*time.Duration(1<<min(max(attempt-1, 0), 6)), 5*time.Minute)
}

func (s *Service) Run(ctx context.Context) {
	if s.cfg.BatonURL == "" {
		s.logger.Warn("event=plane_writeback_config_missing")
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := s.retryPending(ctx); err != nil && ctx.Err() == nil {
			s.logger.Warn("event=plane_retry_scan_failed")
		}
		if err := s.retryWritebacks(ctx); err != nil && ctx.Err() == nil {
			s.logger.Warn("event=plane_writeback_scan_failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) retryPending(ctx context.Context) error {
	scanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := s.pool.Query(scanCtx, `SELECT delivery_id::text FROM plane_deliveries
		WHERE webhook_id=$1 AND project_id=$2 AND processed_at IS NULL AND next_attempt_at<=now()
		ORDER BY next_attempt_at,received_at LIMIT 16`, s.cfg.WebhookID, s.cfg.ProjectID)
	if err != nil {
		return err
	}
	var deliveries []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		deliveries = append(deliveries, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range deliveries {
		if _, err := s.process(ctx, id, true); err != nil && ctx.Err() == nil {
			s.logger.Warn("event=plane_retry_failed", "delivery_id", id)
		}
	}
	return nil
}
