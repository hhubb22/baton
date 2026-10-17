package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

type fakeFiles struct {
	mu     sync.Mutex
	calls  int
	result protocol.FileResult
	err    error
}

func (f *fakeFiles) BrowseFiles(_ context.Context, _, _ string, req protocol.FileRequest) (protocol.FileResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return protocol.FileResult{}, f.err
	}
	result := f.result
	result.Type = protocol.BodyFileResult
	result.OperationID = req.OperationID
	return result, nil
}

func (f *fakeFiles) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestFileBrowseRejectsEscapeOfflineAndForeignNode(t *testing.T) {
	pool := dbtestOpen(t)
	logs := &bytes.Buffer{}
	files := &fakeFiles{result: protocol.FileResult{
		OK:      true,
		Kind:    protocol.FileKindFile,
		RootID:  "notes",
		Path:    "hello.txt",
		Content: strPtr("SECRET_PREVIEW_TEXT"),
	}}
	api := newFileAPI(t, pool, logs, files)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	aliceClient := tlsClient(t, srv)
	bobClient := tlsClient(t, srv)
	const password = "file-browse-password"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	_ = createEmployee(t, pool, "bob", "Bob", password)
	aliceCSRF := loginFor(t, aliceClient, srv.URL, "alice", password)
	_ = loginFor(t, bobClient, srv.URL, "bob", password)
	desk := registerIdent(t, aliceClient, srv.URL, aliceCSRF, "Desk")
	desk.Credential.Token = ""

	offlineStatus, offlineBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files")
	if offlineStatus != http.StatusConflict || !strings.Contains(offlineBody, `"code":"node_offline"`) || files.Calls() != 0 {
		t.Fatalf("离线节点状态 %d %s calls=%d", offlineStatus, offlineBody, files.Calls())
	}
	markOnline(t, pool, alice.ID, desk)
	escapedStatus, escapedBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files?root_id=notes&path=../secret")
	if escapedStatus != http.StatusForbidden || !strings.Contains(escapedBody, `"code":"path_escaped"`) || files.Calls() != 0 || strings.Contains(escapedBody, "SECRET_PREVIEW_TEXT") {
		t.Fatalf("越界路径状态 %d %s", escapedStatus, escapedBody)
	}
	absoluteStatus, absoluteBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files?root_id=notes&path="+absProbe())
	if absoluteStatus != http.StatusForbidden || !strings.Contains(absoluteBody, `"code":"path_escaped"`) || files.Calls() != 0 {
		t.Fatalf("绝对路径状态 %d %s", absoluteStatus, absoluteBody)
	}
	offsetStatus, offsetBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files?root_id=notes&path=hello.txt&offset=65536")
	if offsetStatus != http.StatusBadRequest || files.Calls() != 0 {
		t.Fatalf("偏移续读状态 %d %s", offsetStatus, offsetBody)
	}
	postStatus, postBody, _ := postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files", origin, "", map[string]any{"content": "edited"}, aliceCSRF)
	if postStatus != http.StatusMethodNotAllowed || files.Calls() != 0 || strings.Contains(postBody, "edited") {
		t.Fatalf("写操作状态 %d %s", postStatus, postBody)
	}

	okStatus, okBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files?root_id=notes&path=hello.txt")
	if okStatus != http.StatusOK || !strings.Contains(okBody, "SECRET_PREVIEW_TEXT") || !strings.Contains(okBody, `"truncated":false`) || files.Calls() != 1 {
		t.Fatalf("本人预览状态 %d %s", okStatus, okBody)
	}
	if strings.Contains(logs.String(), "SECRET_PREVIEW_TEXT") || strings.Contains(logs.String(), "hello.txt") {
		t.Fatal("浏览日志包含路径或预览内容")
	}
	var outbox int
	if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM dispatch_outbox`).Scan(&outbox); err != nil || outbox != 0 {
		t.Fatalf("浏览写入了 outbox: %v %d", err, outbox)
	}

	files.result = protocol.FileResult{
		OK:        true,
		Kind:      protocol.FileKindFile,
		Truncated: true,
		Content:   strPtr(strings.Repeat("B", protocol.FilePreviewBytes+32)),
		Remainder: &protocol.FileRemainder{RootID: "notes", Path: "big.txt", Kind: protocol.FileKindFile, Offset: int64(protocol.FilePreviewBytes + 32), Size: 999999},
	}
	bigStatus, bigBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files?root_id=notes&path=big.txt")
	if bigStatus != http.StatusOK || !strings.Contains(bigBody, `"truncated":true`) || strings.Count(bigBody, "B") > protocol.FilePreviewBytes {
		t.Fatalf("中心转发了超限预览: %d count=%d", bigStatus, strings.Count(bigBody, "B"))
	}

	missing, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	foreignStatus, foreignBody := getText(t, bobClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files")
	missingStatus, missingBody := getText(t, bobClient, srv.URL+"/api/v1/nodes/"+missing+"/files")
	foreignCode, foreignMessage := errorFields(t, foreignBody)
	missingCode, missingMessage := errorFields(t, missingBody)
	if foreignStatus != http.StatusForbidden || missingStatus != http.StatusForbidden || foreignCode != missingCode || foreignMessage != missingMessage || strings.Contains(foreignBody, desk.NodeID) || strings.Contains(foreignBody, "Desk") {
		t.Fatalf("他人节点和缺失节点不一致: %d %s / %d %s", foreignStatus, foreignBody, missingStatus, missingBody)
	}
	beforeRevoke := files.Calls()
	if _, err := pool.Exec(context.Background(), `UPDATE nodes SET revoked_at = now() WHERE id = $1::uuid`, desk.NodeID); err != nil {
		t.Fatal(err)
	}
	revokedStatus, revokedBody := getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+desk.NodeID+"/files?root_id=notes")
	if revokedStatus != http.StatusConflict || !strings.Contains(revokedBody, `"code":"revoked"`) || files.Calls() != beforeRevoke {
		t.Fatalf("已吊销节点状态 %d %s", revokedStatus, revokedBody)
	}
}

func newFileAPI(t *testing.T, pool *pgxpool.Pool, logs io.Writer, files httpapi.FileBrowser) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(logs, nil))
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
		Files:             files,
		Logger:            logger,
	})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func markOnline(t *testing.T, pool *pgxpool.Pool, employeeID string, ident node.Identity) {
	t.Helper()
	incarnation, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	connID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	err = store.New(pool).UpsertPresence(context.Background(), protocol.Presence{
		NodeID:       ident.NodeID,
		EmployeeID:   employeeID,
		CredentialID: ident.Credential.ID,
		Incarnation:  incarnation,
		ConnID:       connID,
		Online:       true,
		LastContact:  time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func strPtr(value string) *string { return &value }

func absProbe() string {
	return "/etc/passwd"
}

func dbtestOpen(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return dbtest.Open(t)
}

func errorFields(t *testing.T, body string) (string, string) {
	t.Helper()
	var parsed struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed.Code, parsed.Message
}
