package gateway_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/control"
	"baton/internal/dbtest"
	"baton/internal/gateway"
	"baton/internal/httpapi"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
)

func TestWebProjectExecSavesOnRealNodeAndReports(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	emp, err := admin.CreateLocal(ctx, pool, "settings-owner", "Owner", "settings-password-001")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE employees SET must_change_password=false WHERE id=$1`, emp.ID); err != nil {
		t.Fatal(err)
	}
	credential, err := repo.FindLocalCredential(ctx, emp.Username)
	if err != nil {
		t.Fatal(err)
	}
	token, csrf, _, err := repo.InsertSession(ctx, emp.ID, credential.PasswordHash, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ident := registerNode(t, ctx, repo, signer, emp.ID, "Desk")
	ctrl, err := control.New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	gw := gateway.New(ctrl, ctrl, 30*time.Second, nil)
	defer gw.Close()
	ctrl.SetSender(gw)
	mux := http.NewServeMux()
	mux.Handle("/v1/node", gw)
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()
	api, err := httpapi.New(pool, httpapi.Settings{Origins: []string{srv.URL}, SessionTTL: time.Hour, EnrollmentTTL: time.Minute, NodeCredentialTTL: time.Hour, Signer: signer, NodeSettings: ctrl})
	if err != nil {
		t.Fatal(err)
	}
	mux.Handle("/api/v1/", api)
	go gw.Run(ctx)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	dir := t.TempDir()
	if err := node.WriteProjectExec(dir, protocol.RuntimeExec{Enabled: false, Shell: "/bin/sh"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	stopped := make(chan error, 1)
	loginDone := make(chan func(), 4)
	var loginCalls atomic.Int32
	startLogin := func(ctx context.Context, provider string, onDone func()) (protocol.SubscriptionLoginResult, error) {
		loginCalls.Add(1)
		loginDone <- onDone
		return protocol.SubscriptionLoginResult{OK: true, Provider: provider, VerificationURI: "https://example.test/device", UserCode: "CODE-1234", ExpiresInSeconds: 600}, nil
	}
	go func() {
		stopped <- node.Maintain(ctx, node.RunOptions{RelayURL: "wss://" + strings.TrimPrefix(srv.URL, "https://") + "/v1/node", Identity: ident, Heartbeat: 100 * time.Millisecond, RootCAs: roots, DataDir: dir, StartSubscriptionLogin: startLogin, RuntimeReportInterval: time.Hour})
	}()
	defer func() {
		cancel()
		select {
		case err := <-stopped:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("node did not stop")
		}
	}()
	wait := func(check func() bool) {
		t.Helper()
		deadline := time.NewTimer(6 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			if check() {
				return
			}
			select {
			case <-deadline.C:
				t.Fatal("node confirmation timed out")
			case <-ticker.C:
			}
		}
	}
	wait(func() bool {
		v, err := repo.OwnNode(ctx, emp.ID, ident.NodeID)
		return err == nil && v.Executable() && v.RuntimeReport != nil
	})
	call := func(enabled bool, sessionToken, csrfToken string) (int, string) {
		t.Helper()
		raw, _ := json.Marshal(map[string]bool{"enabled": enabled})
		req, _ := http.NewRequest("PUT", srv.URL+"/api/v1/nodes/"+ident.NodeID+"/project-exec", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", srv.URL)
		req.Header.Set(auth.CSRFHeader, csrfToken)
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: sessionToken})
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	if status, body := call(true, token, ""); status != 403 {
		t.Fatal(status, body)
	}
	cfg, err := node.ReadProjectExec(dir)
	if err != nil || cfg.Enabled {
		t.Fatal(cfg, err)
	}
	for _, enabled := range []bool{true, false} {
		status, body := call(enabled, token, csrf)
		if status != 200 {
			t.Fatal(status, body)
		}
		cfg, err = node.ReadProjectExec(dir)
		if err != nil || cfg.Enabled != enabled || cfg.Shell != "/bin/sh" {
			t.Fatal(cfg, err)
		}
		var response struct {
			ID     string `json:"id"`
			Report struct {
				Exec struct {
					Enabled bool `json:"enabled"`
				} `json:"exec"`
			} `json:"runtime_report"`
		}
		if json.Unmarshal([]byte(body), &response) != nil || response.ID != ident.NodeID || response.Report.Exec.Enabled != enabled {
			t.Fatal(body)
		}
		wait(func() bool {
			v, err := repo.OwnNode(ctx, emp.ID, ident.NodeID)
			return err == nil && v.RuntimeReport != nil && v.RuntimeReport.Exec.Enabled == enabled
		})
	}
	settingsCall := func(method, suffix, body, sessionToken, csrfToken string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+"/api/v1/nodes/"+ident.NodeID+suffix, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", srv.URL)
		req.Header.Set(auth.CSRFHeader, csrfToken)
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: sessionToken})
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(raw)
	}
	t.Run("Web目录管理", func(t *testing.T) {
		path := t.TempDir()
		if err := os.Mkdir(filepath.Join(path, ".git"), 0700); err != nil {
			t.Fatal(err)
		}
		path, _ = filepath.EvalSymlinks(path)
		payload, _ := json.Marshal(map[string]string{"path": path})
		if status, body := settingsCall("POST", "/roots", string(payload), token, ""); status != 403 {
			t.Fatal(status, body)
		}
		registered, err := node.ListBrowseRoots(dir)
		if err != nil || len(registered) != 0 {
			t.Fatal(registered, err)
		}
		for i := 0; i < 2; i++ {
			status, body := settingsCall("POST", "/roots", string(payload), token, csrf)
			if status != 200 {
				t.Fatal(status, body)
			}
			var response struct {
				Report protocol.RuntimeReport `json:"runtime_report"`
			}
			if json.Unmarshal([]byte(body), &response) != nil || len(response.Report.Roots) != 1 || response.Report.Roots[0].Path != path || len(response.Report.Repos) != 1 || response.Report.Repos[0].Path != path {
				t.Fatal(body)
			}
		}
		wait(func() bool {
			v, err := repo.OwnNode(ctx, emp.ID, ident.NodeID)
			return err == nil && v.RuntimeReport != nil && len(v.RuntimeReport.Roots) == 1 && len(v.RuntimeReport.Repos) == 1
		})
		for _, body := range []string{`{"path":"relative"}`, `{"path":""}`, `{}`} {
			if status, response := settingsCall("POST", "/roots", body, token, csrf); status != 400 || !strings.Contains(response, "invalid_path") {
				t.Fatal(status, response)
			}
		}
		missing, _ := json.Marshal(map[string]string{"path": filepath.Join(path, "missing")})
		if status, response := settingsCall("POST", "/roots", string(missing), token, csrf); status != 400 {
			t.Fatal(status, response)
		}
		file := filepath.Join(path, "file")
		if err := os.WriteFile(file, []byte("内容"), 0600); err != nil {
			t.Fatal(err)
		}
		invalid, _ := json.Marshal(map[string]string{"path": file})
		if status, response := settingsCall("POST", "/roots", string(invalid), token, csrf); status != 400 || !strings.Contains(response, "path_escaped") {
			t.Fatal(status, response)
		}
		if status, body := settingsCall("DELETE", "/roots", string(payload), token, csrf); status != 200 {
			t.Fatal(status, body)
		} else {
			var response struct {
				Report protocol.RuntimeReport `json:"runtime_report"`
			}
			if json.Unmarshal([]byte(body), &response) != nil || len(response.Report.Roots) != 0 || len(response.Report.Repos) != 0 {
				t.Fatal(body)
			}
		}
		registered, err = node.ListBrowseRoots(dir)
		if err != nil || len(registered) != 0 {
			t.Fatal(registered, err)
		}
		wait(func() bool {
			v, err := repo.OwnNode(ctx, emp.ID, ident.NodeID)
			return err == nil && v.RuntimeReport != nil && len(v.RuntimeReport.Roots) == 0 && len(v.RuntimeReport.Repos) == 0
		})
		if status, body := settingsCall("DELETE", "/roots", string(payload), token, csrf); status != 403 {
			t.Fatal(status, body)
		}
	})
	t.Run("Web订阅登录", func(t *testing.T) {
		if status, body := settingsCall("POST", "/subscriptions/login", `{"provider":"xai"}`, token, ""); status != 403 {
			t.Fatal(status, body)
		}
		if loginCalls.Load() != 0 {
			t.Fatal("未授权请求发起了登录")
		}
		for input, provider := range map[string]string{"ChatGPT": "openai-codex", "xAI": "xai"} {
			status, body := settingsCall("POST", "/subscriptions/login", `{"provider":"`+input+`"}`, token, csrf)
			var response struct {
				Provider string `json:"provider"`
				URI      string `json:"verification_uri"`
				Code     string `json:"user_code"`
				Expires  int    `json:"expires_in_seconds"`
			}
			if status != 200 || json.Unmarshal([]byte(body), &response) != nil || response.Provider != provider || response.URI != "https://example.test/device" || response.Code != "CODE-1234" || response.Expires != 600 {
				t.Fatal(status, body)
			}
			select {
			case done := <-loginDone:
				done()
			case <-time.After(time.Second):
				t.Fatal("登录未注册完成通知")
			}
		}
		if status, body := settingsCall("POST", "/subscriptions/login", `{"provider":"unknown"}`, token, csrf); status != 400 {
			t.Fatal(status, body)
		}
		if loginCalls.Load() != 2 {
			t.Fatal("不支持的服务发起了登录")
		}
	})
	cancel()
	wait(func() bool { v, err := repo.OwnNode(t.Context(), emp.ID, ident.NodeID); return err == nil && !v.Online })
	if status, body := call(true, token, csrf); status != 503 {
		t.Fatal(status, body)
	}
	cfg, err = node.ReadProjectExec(dir)
	if err != nil || cfg.Enabled {
		t.Fatal("offline setting changed", cfg, err)
	}
	for _, endpoint := range []struct{ suffix, body string }{{"/roots", `{"path":"/tmp"}`}, {"/subscriptions/login", `{"provider":"xai"}`}} {
		if status, body := settingsCall("POST", endpoint.suffix, endpoint.body, token, csrf); status != 503 || !strings.Contains(body, "node_offline") {
			t.Fatal(status, body)
		}
	}
}
