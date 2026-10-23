package sidecar

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBundleAllowsSymlinkedInstallParentAndRejectsEscapedEntry(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("未安装 Node.js")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(root, "installed")
	bundle := filepath.Join(installed, "sidecars", "project-agent")
	if err := os.MkdirAll(bundle, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"name":"project-agent","version":"0.1.0","protocol":1,"entry":"index.js"}`
	if err := os.WriteFile(filepath.Join(bundle, "manifest.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(bundle, "index.js")
	if err := os.WriteFile(entry, []byte("// fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(installed, alias); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("当前 Windows 用户不能创建符号链接")
		}
		t.Fatal(err)
	}
	if _, err := commandAt(context.Background(), alias, "project-agent", "0.1.0", "missing"); err != nil {
		t.Fatalf("合法安装路径经过符号链接时无法定位 Runtime: %v", err)
	}
	outside := filepath.Join(root, "outside.js")
	if err := os.WriteFile(outside, []byte("// outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, entry); err != nil {
		t.Fatal(err)
	}
	if _, err := commandAt(context.Background(), alias, "project-agent", "0.1.0", "missing"); err == nil || !strings.Contains(err.Error(), "越过 bundle") {
		t.Fatalf("入口指向 bundle 外部时未拒绝: %v", err)
	}
}
