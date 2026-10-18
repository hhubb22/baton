package plane

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os/exec"
	"testing"
	"time"
)

func TestCoordinatorWritebackRestart(t *testing.T) {
	f, a, _ := setupWriteback(t)
	binary, env := coordinatorEnv(t, f)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	cfg, err := json.Marshal(f.cfg)
	if err != nil {
		t.Fatal(err)
	}
	env = append(env, "BATON_HTTP_ADDR="+addr, "BATON_PLANE_CONFIG="+string(cfg), "BATON_PLANE_URL="+f.cfg.URL, "BATON_PLANE_API_KEY="+f.cfg.APIKey, "BATON_PLANE_WEBHOOK_SECRET="+f.cfg.Secret)
	start := func() *exec.Cmd {
		cmd := exec.Command(binary, "serve")
		cmd.Env = env
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			resp, err := http.Get("http://" + addr + Path)
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode == 405 {
					return cmd
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("Coordinator 未就绪")
		return nil
	}
	a.mu.Lock()
	a.lose = true
	a.mu.Unlock()
	cmd := start()
	wait := func(query string, want int) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for {
			var n int
			err := f.pool.QueryRow(context.Background(), query).Scan(&n)
			if err == nil && n == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("中心事实 %d 期望 %d %v", n, want, err)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	wait(`SELECT count(*) FROM plane_outbox WHERE attempts=1 AND last_error_code='unavailable'`, 1)
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	writebackDue(t, f)
	start()
	wait(`SELECT count(*) FROM plane_outbox WHERE delivered_at IS NOT NULL`, 1)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.posts != 1 || len(a.rows) != 1 {
		t.Fatalf("重启重复评论 %d %d", a.posts, len(a.rows))
	}
	f.assertTasks(1)
}
