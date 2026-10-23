package gateway_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	go func() {
		stopped <- node.Maintain(ctx, node.RunOptions{RelayURL: "wss://" + strings.TrimPrefix(srv.URL, "https://") + "/v1/node", Identity: ident, Heartbeat: 100 * time.Millisecond, RootCAs: roots, DataDir: dir})
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
	cancel()
	wait(func() bool { v, err := repo.OwnNode(t.Context(), emp.ID, ident.NodeID); return err == nil && !v.Online })
	if status, body := call(true, token, csrf); status != 503 {
		t.Fatal(status, body)
	}
	cfg, err = node.ReadProjectExec(dir)
	if err != nil || cfg.Enabled {
		t.Fatal("offline setting changed", cfg, err)
	}
}
