package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/node"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRevokeIsOwnerScopedAndStaysPendingWithoutRelay(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &strings.Builder{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	aliceClient := tlsClient(t, srv)
	bobClient := tlsClient(t, srv)
	const password = "revoke-api-password-01"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	createEmployee(t, pool, "bob", "Bob", password)
	aliceCSRF := loginFor(t, aliceClient, srv.URL, "alice", password)
	bobCSRF := loginFor(t, bobClient, srv.URL, "bob", password)
	desk := registerIdent(t, aliceClient, srv.URL, aliceCSRF, "Desk")
	other := registerIdent(t, aliceClient, srv.URL, aliceCSRF, "Other")

	status, body := postJSONStatus(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/revoke", origin, "", map[string]any{})
	if status != http.StatusForbidden || defaultPC(t, pool, alice.ID) != desk.NodeID {
		t.Fatalf("缺少 CSRF 的吊销状态 %d", status)
	}
	status, body = postJSONStatus(t, bobClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/revoke", origin, bobCSRF, map[string]any{})
	if status != http.StatusForbidden || strings.Contains(body, desk.NodeID) || !strings.Contains(body, "不能吊销该节点") {
		t.Fatalf("跨员工吊销状态 %d %s", status, body)
	}
	status, body = postJSONStatus(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/revoke?x=1", origin, aliceCSRF, map[string]any{})
	if status != http.StatusBadRequest {
		t.Fatalf("URL 参数状态 %d", status)
	}
	if strings.Contains(body, "已生效") || strings.Contains(body, "已经停止") {
		t.Fatal("被拒绝的请求声称吊销已生效或本地进程已停止")
	}

	status, body = postJSONStatus(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/revoke", origin, aliceCSRF, map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("吊销状态 %d %s", status, body)
	}
	var revoked struct {
		NodeID     string     `json:"node_id"`
		Status     string     `json:"status"`
		OperatorID string     `json:"operator_id"`
		Creds      []string   `json:"credential_ids"`
		AppliedAt  *time.Time `json:"applied_at"`
		Message    string     `json:"message"`
		Notice     string     `json:"local_process_notice"`
		DefaultPC  struct {
			NodeID           string `json:"node_id"`
			Invalid          bool   `json:"invalid"`
			NeedsReselection bool   `json:"needs_reselection"`
			Message          string `json:"message"`
		} `json:"default_pc"`
	}
	if err := json.Unmarshal([]byte(body), &revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.Status != "pending" || revoked.AppliedAt != nil || revoked.OperatorID != alice.ID || revoked.NodeID != desk.NodeID {
		t.Fatalf("没有 Relay 时不应显示已生效: %+v", revoked)
	}
	if len(revoked.Creds) != 1 || revoked.Creds[0] != desk.Credential.ID {
		t.Fatalf("响应没有关联凭据: %+v", revoked.Creds)
	}
	if !strings.Contains(revoked.Message, "尚未生效") || !strings.Contains(revoked.Notice, "不会停止") || strings.Contains(body, "已生效") || strings.Contains(body, "已经停止") {
		t.Fatalf("处理中的说明不正确: %s", body)
	}
	if revoked.DefaultPC.NodeID != desk.NodeID || !revoked.DefaultPC.Invalid || !revoked.DefaultPC.NeedsReselection || !strings.Contains(revoked.DefaultPC.Message, "需要重新选择") || !strings.Contains(revoked.DefaultPC.Message, "不会自动改选") {
		t.Fatalf("默认设备提示不正确: %+v", revoked.DefaultPC)
	}
	if defaultPC(t, pool, alice.ID) != desk.NodeID {
		t.Fatal("吊销改写了默认设备")
	}

	status, body = getText(t, aliceClient, srv.URL+"/api/v1/nodes")
	if status != http.StatusOK || !strings.Contains(body, desk.NodeID) || !strings.Contains(body, other.NodeID) || !strings.Contains(body, `"revocation_status":"pending"`) || strings.Contains(body, `"revocation_status":"effective"`) {
		t.Fatalf("节点查询过早显示已生效: %d %s", status, body)
	}
	if !strings.Contains(body, "不会停止") || strings.Contains(body, "已经停止") || !strings.Contains(body, desk.NodeID) {
		t.Fatal("节点列表没有说明吊销不会停止本地进程，或丢掉了节点")
	}
	status, body = getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID)
	if status != http.StatusOK || !strings.Contains(body, `"executable":false`) || !strings.Contains(body, `"revocation_status":"pending"`) || strings.Contains(body, "已生效") {
		t.Fatalf("节点详情不正确: %d %s", status, body)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var applied int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM node_revocations WHERE node_id = $1::uuid AND applied_at IS NULL AND actor_employee_id = $2::uuid`, desk.NodeID, alice.ID).Scan(&applied); err != nil || applied != 1 {
		t.Fatalf("审计记录不正确: %d %v", applied, err)
	}
	if strings.Contains(logs.String(), desk.Credential.Token) || strings.Contains(logs.String(), password) {
		t.Fatal("吊销日志包含凭据或口令")
	}
}

type markingDispatcher struct {
	repo *store.Store
}

func (d markingDispatcher) DispatchRevocations(ctx context.Context) error {
	_, _, ids, err := d.repo.PendingRevocationSet(ctx)
	if err != nil || len(ids) == 0 {
		return err
	}
	return d.repo.MarkRevocationsApplied(ctx, ids)
}

func TestRevokeShowsEffectiveOnlyAfterAcknowledgement(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &strings.Builder{}
	const password = "revoke-ack-password-01"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	plain := httptest.NewTLSServer(newAPI(t, pool, logs))
	t.Cleanup(plain.Close)
	plainClient := tlsClient(t, plain)
	csrf := loginFor(t, plainClient, plain.URL, "alice", password)
	desk := registerIdent(t, plainClient, plain.URL, csrf, "Desk")

	acked := httptest.NewTLSServer(newRevokeAPI(t, pool, logs, markingDispatcher{repo: store.New(pool)}))
	t.Cleanup(acked.Close)
	ackedClient := tlsClient(t, acked)
	csrf = loginFor(t, ackedClient, acked.URL, "alice", password)
	status, body := postJSONStatus(t, ackedClient, acked.URL+"/api/v1/nodes/"+desk.NodeID+"/revoke", origin, csrf, map[string]any{})
	if status != http.StatusOK || !strings.Contains(body, `"status":"effective"`) || !strings.Contains(body, "不会停止") || strings.Contains(body, "已经停止") {
		t.Fatalf("回执后的响应不正确: %d %s", status, body)
	}
	if !strings.Contains(body, `"applied_at":"`) || !strings.Contains(body, alice.ID) {
		t.Fatalf("回执响应缺少时间或操作者: %s", body)
	}
	status, body = getText(t, ackedClient, acked.URL+"/api/v1/nodes/"+desk.NodeID)
	if status != http.StatusOK || !strings.Contains(body, `"revocation_status":"effective"`) || strings.Contains(body, "已经停止") {
		t.Fatalf("节点查询没有在回执后显示已生效: %d %s", status, body)
	}
}

func newRevokeAPI(t *testing.T, pool *pgxpool.Pool, logs io.Writer, revocations httpapi.RevocationDispatcher) http.Handler {
	t.Helper()
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	api, err := httpapi.New(pool, httpapi.Settings{
		Origins:           []string{origin},
		SessionTTL:        time.Hour,
		EnrollmentTTL:     10 * time.Minute,
		NodeCredentialTTL: 30 * 24 * time.Hour,
		Signer:            signer,
		Revocations:       revocations,
		Logger:            slog.New(slog.NewTextHandler(logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func postJSONStatus(t *testing.T, client *browser, rawURL, origin, csrf string, payload any) (int, string) {
	t.Helper()
	status, body, _ := postJSON(t, client, rawURL, origin, "", payload, csrf)
	return status, body
}
