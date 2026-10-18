package plane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/node"

	"github.com/google/uuid"
)

func coordinatorEnv(t *testing.T, f *fixture) (string, []string) {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "coordinator")
	cmd := exec.Command("go", "build", "-o", binary, "../../cmd/coordinator")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build coordinator: %v\n%s", err, out)
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signer.MarshalPKCS8PEM()
	if err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(dir, "signer.pem")
	if err := os.WriteFile(key, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var schema string
	if err := f.pool.QueryRow(context.Background(), "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "BATON_DATABASE_URL="+os.Getenv("BATON_TEST_DATABASE_URL"), "BATON_DB_SCHEMA="+schema,
		"BATON_CONTROL_ADDR=127.0.0.1:0", "BATON_CONTROL_TOKEN=plane-process-test-token-1234", "BATON_NODE_SIGNING_KEY="+key,
		"BATON_ALLOWED_ORIGINS=https://plane-process.test")
	return binary, env
}

func TestCoordinatorProcessReplay(t *testing.T) {
	f := newFixture(t)
	binary, env := coordinatorEnv(t, f)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	cfg, err := json.Marshal(f.cfg)
	if err != nil {
		t.Fatal(err)
	}
	env = append(env, "BATON_HTTP_ADDR="+address, "BATON_PLANE_CONFIG="+string(cfg), "BATON_PLANE_URL="+f.cfg.URL,
		"BATON_PLANE_API_KEY="+f.cfg.APIKey, "BATON_PLANE_WEBHOOK_SECRET="+f.cfg.Secret)
	start := func() *exec.Cmd {
		cmd := exec.Command(binary, "serve")
		cmd.Env = env
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			resp, err := http.Get("http://" + address + Path)
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusMethodNotAllowed {
					return cmd
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("coordinator webhook did not become ready")
		return nil
	}
	cmd := start()
	raw, err := json.Marshal(f.event("updated", "state"))
	if err != nil {
		t.Fatal(err)
	}
	delivery := uuid.NewString()
	send := func() Result {
		r, _ := http.NewRequest(http.MethodPost, "http://"+address+Path, bytes.NewReader(raw))
		r.Header.Set("X-Plane-Delivery", delivery)
		r.Header.Set("X-Plane-Event", "issue")
		r.Header.Set("X-Plane-Signature", signedRequest(f.cfg, raw, delivery, "issue").Header.Get("X-Plane-Signature"))
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var result Result
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("webhook status %d: %v", resp.StatusCode, err)
		}
		return result
	}
	first := send()
	if first.Outcome != "accepted" || first.TaskID == "" {
		t.Fatalf("first delivery: %+v", first)
	}
	// Wait for the central fact before killing the process, not for a node log.
	f.assertTasks(1)
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	start()
	delivery = uuid.NewString()
	if got := send(); got.TaskID != first.TaskID {
		t.Fatalf("restart replay changed task: %+v", got)
	}
	f.assertTasks(1)
}

// Opt-in: creates only baton-t25-* issues in the authorized test project and removes them.
func TestPlaneLiveReplay(t *testing.T) {
	if os.Getenv("BATON_PLANE_LIVE") != "1" {
		t.Skip("set BATON_PLANE_LIVE=1 with read-only Baton Test vault access")
	}
	f := newFixture(t)
	binary, env := coordinatorEnv(t, f)
	in, err := json.Marshal(f.cfg.Actors[0])
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("python3", "testdata/live_plane.py", binary)
	cmd.Env = env
	cmd.Stdin = bytes.NewReader(in)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("live replay failed: %v\n%s", err, out.String())
	}
	_, _ = io.Copy(os.Stdout, &out)
	f.assertTasks(1)
}
