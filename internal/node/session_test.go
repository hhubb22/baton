package node

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/protocol"

	"github.com/coder/websocket"
)

func TestMaintainStopsWhenCredentialIsRejected(t *testing.T) {
	var accepts atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accepts.Add(1)
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer ws.Close(websocket.StatusPolicyViolation, "")
		ws.SetReadLimit(protocol.MaxMessageBytes)
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if _, _, err := ws.Read(ctx); err != nil {
			return
		}
		raw, _ := json.Marshal(protocol.Frame{Kind: protocol.KindAuthResult, OK: false, Code: protocol.CodeInvalidCredential, Message: "需要重新认证"})
		_ = ws.Write(ctx, websocket.MessageText, raw)
	}))
	srv.StartTLS()
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	endpoint, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.Scheme = "wss"
	endpoint.Path = protocol.NodePath
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err = Maintain(ctx, RunOptions{
		RelayURL:  endpoint.String(),
		Identity:  sampleIdentity(t),
		Heartbeat: time.Second,
		RootCAs:   pool,
	})
	if !errors.Is(err, ErrNeedsReauth) {
		t.Fatalf("认证失败得到 %v", err)
	}
	if accepts.Load() != 1 {
		t.Fatalf("认证失败后重试了 %d 次", accepts.Load())
	}
}
