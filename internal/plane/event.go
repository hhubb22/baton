package plane

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
)

type event struct {
	Event         string `json:"event"`
	Action        string `json:"action"`
	WebhookID     string `json:"webhook_id"`
	WorkspaceID   string `json:"workspace_id"`
	WorkspaceSlug string `json:"workspace_slug"`
	Data          struct {
		ID             string    `json:"id"`
		Issue          string    `json:"issue"`
		Project        string    `json:"project"`
		UpdatedAt      time.Time `json:"updated_at"`
		State          state     `json:"state"`
		ExternalSource string    `json:"external_source"`
	} `json:"data"`
	Activity struct {
		Field string `json:"field"`
		Actor struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"actor"`
	} `json:"activity"`
}

func verify(secret string, body []byte, signature string) bool {
	got, err := hex.DecodeString(signature)
	if secret == "" || err != nil || len(got) != sha256.Size {
		return false
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return hmac.Equal(got, m.Sum(nil))
}

func parseEvent(cfg Config, raw []byte, headerEvent string) (event, error) {
	var e event
	if json.Unmarshal(raw, &e) != nil || e.Event != headerEvent || (e.Event != "issue" && e.Event != "issue_comment") ||
		e.WebhookID != cfg.WebhookID || e.WorkspaceID != cfg.WorkspaceID || e.WorkspaceSlug != cfg.WorkspaceSlug || e.Data.Project != cfg.ProjectID {
		return e, errors.New("invalid event scope")
	}
	for _, id := range []string{e.Data.ID} {
		if _, err := identity.ParseUUID(id); err != nil {
			return e, errors.New("invalid event identity")
		}
	}
	if e.Activity.Actor.ID != "" {
		if _, err := identity.ParseUUID(e.Activity.Actor.ID); err != nil {
			return e, errors.New("invalid actor")
		}
	}
	if e.Event == "issue_comment" {
		if _, err := identity.ParseUUID(e.Data.Issue); err != nil {
			return e, errors.New("invalid comment issue")
		}
	} else if e.Action != "created" && e.Action != "updated" {
		return e, errors.New("invalid issue event")
	}
	return e, nil
}

func (e event) issueID() string {
	if e.Event == "issue_comment" {
		return e.Data.Issue
	}
	return e.Data.ID
}

func triggerID(cfg Config, issueID, activityID string) string {
	sum := sha256.Sum256([]byte(cfg.WebhookID + "/" + cfg.ProjectID + "/" + issueID + "/" + activityID))
	return "plane:" + hex.EncodeToString(sum[:])
}
