// Package webui 提供 Coordinator 嵌入的员工页面。
// 构建结果来自 web 目录的 pnpm build；没有 Node.js 时，已有的 dist 仍可编译。
package webui

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

const csp = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'"

type handler struct {
	next  http.Handler
	files fs.FS
}

// Handler 先提供嵌入的页面和资源。API 和其他未来路径仍交给 next，避免静态文件吞掉 /api 以外的新路由。
func Handler(next http.Handler) http.Handler {
	root, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err)
	}
	return &handler{next: next, files: root}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.next == nil {
		http.Error(w, "暂时无法处理请求", http.StatusInternalServerError)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.next.ServeHTTP(w, r)
		return
	}
	name := staticName(r.URL.Path)
	if name == "" {
		h.next.ServeHTTP(w, r)
		return
	}
	if name != "index.html" {
		info, err := fs.Stat(h.files, name)
		if err != nil || info.IsDir() {
			h.next.ServeHTTP(w, r)
			return
		}
	}
	h.write(w, r, name)
}

func staticName(raw string) string {
	cleaned := path.Clean("/" + raw)
	switch cleaned {
	case "/", "/index.html":
		return "index.html"
	}
	if cleaned == "/projects" || strings.HasPrefix(cleaned, "/projects/") || cleaned == "/tasks" || strings.HasPrefix(cleaned, "/tasks/") {
		return "index.html"
	}
	if !strings.HasPrefix(cleaned, "/") || strings.Contains(cleaned, "\\") {
		return ""
	}
	return strings.TrimPrefix(cleaned, "/")
}

func (h *handler) write(w http.ResponseWriter, r *http.Request, name string) {
	file, err := h.files.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		http.NotFound(w, r)
		return
	}
	seeker, ok := file.(io.ReadSeeker)
	if !ok {
		http.Error(w, "暂时无法处理请求", http.StatusInternalServerError)
		return
	}
	header := w.Header()
	header.Set("Content-Security-Policy", csp)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Frame-Options", "DENY")
	header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("X-Permitted-Cross-Domain-Policies", "none")
	switch {
	case name == "index.html":
		header.Set("Cache-Control", "no-store")
	case strings.HasPrefix(name, "assets/"):
		header.Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		header.Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), seeker)
}
