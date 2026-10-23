package node

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/auth"
)

func TestRegisterKeepsEnrollmentTokenOutOfURL(t *testing.T) {
	token, err := auth.NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	ident := sampleIdentity(t)
	var seenURI, authz string
	var body []byte
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenURI = r.RequestURI
		authz = r.Header.Get("Authorization")
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ident)
	}))
	defer srv.Close()
	ca := writeCert(t, srv.Certificate())
	got, err := Register(context.Background(), RegisterRequest{
		CoordinatorURL:  srv.URL,
		CAFile:          ca,
		EnrollmentToken: token,
		DisplayName:     "Desk",
		System:          SystemLinux,
		Role:            RolePC,
		Capabilities:    []string{"start"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeID != ident.NodeID || got.Credential.Token != ident.Credential.Token || got.CoordinatorURL != srv.URL {
		t.Fatal("注册结果没有保留节点身份")
	}
	if seenURI != "/api/v1/nodes/register" || strings.Contains(seenURI, token) || strings.Contains(authz, token) {
		t.Fatal("注册凭据进入了 URL 或 Authorization 头")
	}
	if !strings.Contains(string(body), token) {
		t.Fatal("注册请求正文没有带上凭据")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err = Register(ctx, RegisterRequest{
		CoordinatorURL:  "http://127.0.0.1:1",
		EnrollmentToken: token,
		DisplayName:     "Desk",
		System:          SystemLinux,
		Role:            RolePC,
	})
	if err == nil || strings.Contains(err.Error(), token) || !strings.Contains(err.Error(), "https") {
		t.Fatalf("明文地址未被拒绝: %v", err)
	}
	_, err = Register(ctx, RegisterRequest{
		CoordinatorURL:  "https://user:" + token + "@baton.example",
		EnrollmentToken: token,
		DisplayName:     "Desk",
		System:          SystemLinux,
		Role:            RolePC,
	})
	if err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("地址中的凭据被接受或回显: %v", err)
	}
}

func TestCoordinatorURLs(t *testing.T) {
	for _, tc := range []struct{ raw, normalized, relay string }{
		{" https://Baton.Example:443/ ", "https://baton.example", "wss://baton.example/v1/node"},
		{"https://baton.example:8443", "https://baton.example:8443", "wss://baton.example:8443/v1/node"},
		{"https://[::1]:443/", "https://[::1]", "wss://[::1]/v1/node"},
	} {
		got, err := NormalizeCoordinatorURL(tc.raw)
		if err != nil || got != tc.normalized {
			t.Fatalf("规范中心地址 %q: %q %v", tc.raw, got, err)
		}
		relay, err := RelayURL(tc.raw)
		if err != nil || relay != tc.relay {
			t.Fatalf("推导连接地址 %q: %q %v", tc.raw, relay, err)
		}
	}
	for _, raw := range []string{"", "http://baton.example", "wss://baton.example", "https://user:password@baton.example", "https://baton.example/api", "https://baton.example?token=secret", "https://baton.example?", "https://baton.example#", "https://baton.example#fragment", "https:///missing", "https://baton.example/%2f"} {
		if _, err := NormalizeCoordinatorURL(raw); err == nil {
			t.Fatalf("接受无效中心地址 %q", raw)
		}
		if _, err := RelayURL(raw); err == nil {
			t.Fatalf("从无效中心地址推导连接地址 %q", raw)
		}
	}
}

func writeCert(t *testing.T, cert *x509.Certificate) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.pem")
	var buf strings.Builder
	if err := pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(buf.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
