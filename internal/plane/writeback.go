package plane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"strings"
	"time"

	"baton/internal/identity"
	"baton/internal/redact"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

type writeback struct {
	ID       string
	TaskID   string
	IssueID  string
	LeaseID  string
	Version  int
	Attempts int
	Snapshot writebackSnapshot
}

type writebackSnapshot struct {
	ErrorCode       string `json:"error_code"`
	StartAuthorized bool   `json:"start_authorized"`
	Status          string `json:"status"`
	Summary         string `json:"summary"`
	Evidence        []struct {
		Position     int    `json:"position"`
		AccessStatus string `json:"access_status"`
	} `json:"evidence"`
	Acceptance *struct {
		TaskVersion int       `json:"task_version"`
		Decision    string    `json:"decision"`
		Comment     string    `json:"comment"`
		EmployeeID  string    `json:"employee_id"`
		CreatedAt   time.Time `json:"created_at"`
	} `json:"acceptance"`
}

type comment struct {
	ID             string `json:"id"`
	Issue          string `json:"issue"`
	Project        string `json:"project"`
	Workspace      string `json:"workspace"`
	HTML           string `json:"comment_html"`
	Access         string `json:"access"`
	ExternalSource string `json:"external_source"`
	ExternalID     string `json:"external_id"`
}

// retryWritebacks 只消费已提交的回写意图，不接受或重发执行输入。
func (s *Service) retryWritebacks(ctx context.Context) error {
	if s.cfg.BatonURL == "" {
		return nil
	}
	for range 16 {
		item, ok, err := s.claimWriteback(ctx)
		if err != nil || !ok {
			return err
		}
		attemptCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
		commentID, sendErr := s.writeComment(attemptCtx, item)
		cancel()
		if sendErr != nil {
			_, err = s.pool.Exec(ctx, `UPDATE plane_outbox SET last_error_code='unavailable',lease_id=NULL,
				next_attempt_at=now()+$3::bigint*interval '1 millisecond' WHERE id=$1 AND lease_id=$2`, item.ID, item.LeaseID, retryDelay(item.Attempts).Milliseconds())
			s.logger.Warn("event=plane_writeback_pending", "writeback_id", item.ID)
		} else {
			_, err = s.pool.Exec(ctx, `UPDATE plane_outbox SET comment_id=$3,delivered_at=now(),last_error_code='',lease_id=NULL
				WHERE id=$1 AND lease_id=$2`, item.ID, item.LeaseID, commentID)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) claimWriteback(ctx context.Context) (writeback, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return writeback{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out writeback
	err = tx.QueryRow(ctx, `SELECT o.id::text,o.task_id::text,o.task_version,o.snapshot,o.attempts,p.issue_id::text
		FROM plane_outbox o JOIN plane_triggers p ON p.trigger_id=o.trigger_id
		WHERE p.webhook_id=$1 AND p.project_id=$2 AND o.delivered_at IS NULL AND o.next_attempt_at<=now()
		AND NOT EXISTS(SELECT 1 FROM plane_outbox prev WHERE prev.trigger_id=o.trigger_id
			AND prev.task_version<o.task_version AND prev.delivered_at IS NULL)
		ORDER BY o.next_attempt_at,o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, s.cfg.WebhookID, s.cfg.ProjectID).Scan(
		&out.ID, &out.TaskID, &out.Version, &out.Snapshot, &out.Attempts, &out.IssueID)
	if errors.Is(err, pgx.ErrNoRows) {
		return writeback{}, false, nil
	}
	if err != nil {
		return writeback{}, false, err
	}
	out.LeaseID, err = identity.NewUUID()
	if err != nil {
		return writeback{}, false, err
	}
	out.Attempts++
	_, err = tx.Exec(ctx, `UPDATE plane_outbox SET attempts=attempts+1,lease_id=$2,
		next_attempt_at=now()+$3::bigint*interval '1 millisecond' WHERE id=$1`, out.ID, out.LeaseID, (attemptTimeout + retryDelay(out.Attempts)).Milliseconds())
	if err != nil {
		return writeback{}, false, err
	}
	return out, true, tx.Commit(ctx)
}

func (s *Service) commentHTML(item writeback) string {
	taskURL := strings.TrimRight(s.cfg.BatonURL, "/") + "/api/v1/tasks/" + item.TaskID
	status := map[string]string{"queued": "排队中", "running": "执行中", "completed": "执行成功，待员工验收", "failed": "执行失败", "cancelled": "已取消", "needs_verification": "结果待核实"}[item.Snapshot.Status]
	if item.Snapshot.Status == "completed" && item.Snapshot.Acceptance != nil {
		status = "执行成功"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "<p>baton-writeback %s</p><p><a href=\"%s\">Baton 任务</a> · 版本 %d · %s</p>", item.ID, html.EscapeString(taskURL), item.Version, status)
	short := func(s string) string {
		runes := []rune(redact.Scrub(s))
		if len(runes) > 500 {
			runes = append(runes[:500], '…')
		}
		return html.EscapeString(string(runes))
	}
	reason := map[string]string{
		"queue_timeout": "排队超时", "execution_timeout": "执行超时", "unavailable": "目标节点暂时不可用",
		"revoked": "节点凭据已吊销", "session_busy": "目标 Session 正忙", "unsupported": "目标不支持该操作",
		"invalid_target": "目标无效", "result_format": "执行器没有交回可校验的结构化结果",
		"execution_failed": "执行失败，详细证据见 Baton 任务", "artifact_unavailable": "任务所需文件不可访问",
	}[item.Snapshot.ErrorCode]
	if message, ok := task.UncertainMessage(item.Snapshot.ErrorCode); ok {
		reason = message
	}
	if item.Snapshot.Status == "cancelled" {
		reason = "员工请求取消"
	}
	if reason != "" {
		fmt.Fprintf(&b, "<p>原因：%s</p>", html.EscapeString(reason))
	}
	if item.Snapshot.Status == "failed" || item.Snapshot.Status == "cancelled" || item.Snapshot.Status == "needs_verification" {
		impact := "未获启动授权"
		if item.Snapshot.StartAuthorized {
			impact = "曾获启动授权，外部影响以任务证据为准"
		}
		fmt.Fprintf(&b, "<p>%s</p>", impact)
	}

	if item.Snapshot.Summary != "" {
		fmt.Fprintf(&b, "<p>%s</p>", short(item.Snapshot.Summary))
	}
	for _, ref := range item.Snapshot.Evidence {
		// 引用通过本人任务接口读取，评论不复制存储路径、资源名或工具输出。
		fmt.Fprintf(&b, "<p>证据 %d：<a href=\"%s\">查看任务证据</a>（%s）</p>", ref.Position+1, html.EscapeString(taskURL), html.EscapeString(ref.AccessStatus))
	}
	if a := item.Snapshot.Acceptance; a != nil {
		decision := "员工验收不通过"
		if a.Decision == "passed" {
			decision = "员工验收通过"
		}
		fmt.Fprintf(&b, "<p>%s · 验收版本 %d · 员工 %s · %s</p><p>%s</p>", decision, a.TaskVersion, html.EscapeString(a.EmployeeID), a.CreatedAt.UTC().Format(time.RFC3339), short(a.Comment))
	}
	return b.String()
}

func (s *Service) validComment(c comment, item writeback) bool {
	_, err := identity.ParseUUID(c.ID)
	return err == nil && c.Issue == item.IssueID && c.Project == s.cfg.ProjectID && c.Workspace == s.cfg.WorkspaceID &&
		c.ExternalSource == "baton" && c.ExternalID == item.ID && c.Access == "INTERNAL" &&
		strings.Contains(c.HTML, "baton-writeback "+item.ID)
}

func (s *Service) writeComment(ctx context.Context, item writeback) (string, error) {
	path := s.client.prefix() + "issues/" + item.IssueID + "/comments/"
	// Plane 1.4.2 忽略列表的标记过滤参数，因此逐页核查；读取失败时保留待回写。
	rows, err := list[comment](ctx, s.client, path)
	if err != nil {
		return "", err
	}
	for _, c := range rows {
		if c.ExternalSource == "baton" && c.ExternalID == item.ID {
			if !s.validComment(c, item) {
				return "", errors.New("Plane 回写标记不匹配")
			}
			return c.ID, nil
		}
	}
	raw, err := json.Marshal(map[string]string{"comment_html": s.commentHTML(item), "access": "INTERNAL", "external_source": "baton", "external_id": item.ID})
	if err != nil {
		return "", err
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.URL, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return "", errors.New("Plane 回写请求无效")
	}
	r.Header.Set("X-API-Key", s.cfg.APIKey)
	r.Header.Set("Content-Type", "application/json")
	resp, err := s.client.http.Do(r)
	if err != nil {
		return "", errors.New("Plane 回写响应未确认")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	var created struct {
		ID string `json:"id"`
	}
	if err != nil || len(body) > 2<<20 || (resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusConflict) || json.Unmarshal(body, &created) != nil {
		return "", errors.New("Plane 回写响应无效")
	}
	if _, err := identity.ParseUUID(created.ID); err != nil {
		return "", errors.New("Plane 评论标识无效")
	}
	var confirmed comment
	if err := s.client.get(ctx, path+created.ID+"/", &confirmed); err != nil {
		return "", err
	}
	if !s.validComment(confirmed, item) {
		return "", errors.New("Plane 回写标记不匹配")
	}
	return confirmed.ID, nil
}
