package plane

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type issue struct {
	ID              string     `json:"id"`
	Project         string     `json:"project"`
	Workspace       string     `json:"workspace"`
	Name            string     `json:"name"`
	DescriptionHTML string     `json:"description_html"`
	State           string     `json:"state"`
	Labels          []string   `json:"labels"`
	UpdatedAt       time.Time  `json:"updated_at"`
	UpdatedBy       string     `json:"updated_by"`
	ArchivedAt      *time.Time `json:"archived_at"`
	DeletedAt       *time.Time `json:"deleted_at"`
	IsDraft         bool       `json:"is_draft"`
	ExternalSource  string     `json:"external_source"`
}

type state struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Group string `json:"group"`
}

type label struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type activity struct {
	ID            string    `json:"id"`
	Issue         string    `json:"issue"`
	Project       string    `json:"project"`
	Workspace     string    `json:"workspace"`
	Field         string    `json:"field"`
	Actor         string    `json:"actor"`
	NewIdentifier string    `json:"new_identifier"`
	CreatedAt     time.Time `json:"created_at"`
	Epoch         float64   `json:"epoch"`
}

func (c *client) round(ctx context.Context, cur issue) (activity, error) {
	rows, err := list[activity](ctx, c, c.prefix()+"issues/"+cur.ID+"/activities/")
	if err != nil {
		return activity{}, err
	}
	var latest activity
	for _, a := range rows {
		if a.Issue != cur.ID || a.Project != cur.Project || a.Workspace != cur.Workspace {
			return activity{}, errors.New("Plane activity scope invalid")
		}
		if a.Field == "state" && (latest.ID == "" || a.CreatedAt.After(latest.CreatedAt)) {
			latest = a
		}
	}
	return latest, nil
}

type client struct {
	cfg  Config
	http *http.Client
}

func newClient(cfg Config, transport http.RoundTripper) *client {
	return &client{cfg: cfg, http: &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

func (c *client) get(ctx context.Context, path string, dst any) error {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.cfg.URL, "/")+path, nil)
	if err != nil {
		return errors.New("Plane request invalid")
	}
	r.Header.Set("X-API-Key", c.cfg.APIKey)
	r.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(r)
	if err != nil {
		return errors.New("Plane unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("Plane read failed")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(raw) > 2<<20 || json.Unmarshal(raw, dst) != nil {
		return errors.New("Plane response invalid")
	}
	return nil
}

func (c *client) prefix() string {
	return "/api/v1/workspaces/" + c.cfg.WorkspaceSlug + "/projects/" + c.cfg.ProjectID + "/"
}

func list[T any](ctx context.Context, c *client, path string) ([]T, error) {
	var all []T
	seen := map[string]bool{}
	page := path
	for n := 0; n < 100; n++ {
		var raw json.RawMessage
		if err := c.get(ctx, page, &raw); err != nil {
			return nil, err
		}
		var envelope struct {
			Results         []T    `json:"results"`
			NextPageResults bool   `json:"next_page_results"`
			NextCursor      string `json:"next_cursor"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Results == nil {
			return nil, errors.New("Plane list response invalid")
		}
		all = append(all, envelope.Results...)
		if !envelope.NextPageResults {
			return all, nil
		}
		if envelope.NextCursor == "" || seen[envelope.NextCursor] {
			return nil, errors.New("Plane pagination invalid")
		}
		seen[envelope.NextCursor] = true
		page = path + "?cursor=" + url.QueryEscape(envelope.NextCursor)
	}
	return nil, errors.New("Plane pagination limit exceeded")
}

func (c *client) current(ctx context.Context, id string) (issue, string, bool, error) {
	var version struct {
		Instance struct {
			CurrentVersion string `json:"current_version"`
		} `json:"instance"`
	}
	if err := c.get(ctx, "/api/instances/", &version); err != nil {
		return issue{}, "", false, err
	}
	if version.Instance.CurrentVersion != "1.4.2" {
		return issue{}, "", false, errors.New("Plane version unsupported")
	}
	var cur issue
	if err := c.get(ctx, c.prefix()+"issues/"+id+"/", &cur); err != nil {
		return issue{}, "", false, err
	}
	if cur.ID != id || cur.Project != c.cfg.ProjectID || cur.Workspace != c.cfg.WorkspaceID || cur.UpdatedAt.IsZero() {
		return issue{}, "", false, errors.New("Plane issue scope invalid")
	}
	states, err := list[state](ctx, c, c.prefix()+"states/")
	if err != nil {
		return issue{}, "", false, err
	}
	group := ""
	for _, s := range states {
		if s.ID == cur.State {
			group = s.Group
		}
	}
	if group == "" {
		return issue{}, "", false, errors.New("Plane state unknown")
	}
	approved := false
	if c.cfg.ApprovalLabelID != "" {
		labels, err := list[label](ctx, c, c.prefix()+"labels/")
		if err != nil {
			return issue{}, "", false, err
		}
		for _, l := range labels {
			if l.ID == c.cfg.ApprovalLabelID && l.Name == "design-approved" {
				for _, id := range cur.Labels {
					approved = approved || id == l.ID
				}
			}
		}
	}
	return cur, group, approved, nil
}

func description(cur issue) string {
	z := html.NewTokenizer(strings.NewReader(cur.DescriptionHTML))
	var parts []string
	for {
		typ := z.Next()
		if typ == html.ErrorToken {
			break
		}
		if typ == html.TextToken {
			parts = append(parts, string(z.Text()))
		}
	}
	text := strings.TrimSpace(strings.Join(parts, " "))
	if text == "" || strings.TrimSpace(cur.Name) == "" {
		return ""
	}
	return cur.Name + "\n\n" + text
}
