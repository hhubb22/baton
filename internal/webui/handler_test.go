package webui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestStaticHeadersAndAPIPassthrough(t *testing.T) {
	var seen string
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNoContent)
	})
	h := Handler(api)

	index := httptest.NewRecorder()
	h.ServeHTTP(index, httptest.NewRequest(http.MethodGet, "/", nil))
	if index.Code != http.StatusOK {
		t.Fatalf("首页状态 %d", index.Code)
	}
	csp := index.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'self'") || strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Fatalf("CSP 不正确: %s", csp)
	}
	if index.Header().Get("X-Content-Type-Options") != "nosniff" || index.Header().Get("X-Frame-Options") != "DENY" || index.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("安全头不完整: %v", index.Header())
	}
	if index.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("首页可以被缓存: %s", index.Header().Get("Cache-Control"))
	}
	body := index.Body.String()
	if !strings.Contains(body, `id="root"`) {
		t.Fatal("首页缺少根节点")
	}
	if strings.Contains(body, "http://") || strings.Contains(body, "https://") {
		t.Fatal("首页引用了外部地址")
	}

	asset := regexp.MustCompile(`/assets/[^"']+`).FindString(body)
	if asset == "" {
		t.Fatal("首页没有本地脚本或样式")
	}
	file := httptest.NewRecorder()
	h.ServeHTTP(file, httptest.NewRequest(http.MethodGet, asset, nil))
	if file.Code != http.StatusOK || !strings.Contains(file.Header().Get("Cache-Control"), "immutable") || file.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("静态资源头不正确: %d %v", file.Code, file.Header())
	}

	post := httptest.NewRecorder()
	h.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/v1/login", nil))
	if post.Code != http.StatusNoContent || seen != "/api/v1/login" {
		t.Fatalf("API 没有转发: %d %s", post.Code, seen)
	}
	events := httptest.NewRecorder()
	h.ServeHTTP(events, httptest.NewRequest(http.MethodGet, "/events", nil))
	if seen != "/events" {
		t.Fatal("非静态路径没有交给 API")
	}
	escape := httptest.NewRecorder()
	h.ServeHTTP(escape, httptest.NewRequest(http.MethodGet, "/../../etc/passwd", nil))
	if escape.Code != http.StatusNoContent || strings.Contains(escape.Body.String(), "root:") {
		t.Fatalf("越界路径被当成了静态文件: %d %s", escape.Code, seen)
	}
}

func TestEmbeddedUIHasNoThirdPartyHosts(t *testing.T) {
	root, err := fs.Sub(embedded, "dist")
	if err != nil {
		t.Fatal(err)
	}
	denied := []string{"cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "esm.sh", "ajax.googleapis.com"}
	err = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		raw, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		text := string(raw)
		for _, host := range denied {
			if strings.Contains(text, host) {
				t.Errorf("%s 引用了 %s", name, host)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
