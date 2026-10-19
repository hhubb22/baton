package fileaccess

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeRuntimeRepo(t *testing.T, path, origin string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(path, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, ".git", "config"), []byte("[remote \"origin\"]\n url = "+origin+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "secret.txt"), []byte("file-content-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeScanBoundsAndPrivacy(t *testing.T) {
	dir, root := t.TempDir(), t.TempDir()
	writeRuntimeRepo(t, root, "https://user:credential-secret@git.example/org/repo?token=query-secret")
	deep := root
	for i := 0; i < RuntimeScanDepth+1; i++ {
		deep = filepath.Join(deep, "deep")
	}
	writeRuntimeRepo(t, deep, "https://git.example/hidden/repo")
	outside := t.TempDir()
	writeRuntimeRepo(t, outside, "https://git.example/outside/repo")
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Log("当前环境不支持符号链接")
	}
	if err := AddBrowseRoot(dir, "dev", root); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	roots, repos, truncated := ScanRuntimeRoots(ctx, dir)
	real, _ := filepath.EvalSymlinks(root)
	if len(roots) != 1 || roots[0].Path != real || len(repos) != 1 || repos[0].Path != real || repos[0].Origin != "git.example/org/repo" || !truncated {
		t.Fatalf("扫描结果不正确：%+v %+v %v", roots, repos, truncated)
	}
}

func TestRuntimeScanLimitsLargeDirectoryAndMetadata(t *testing.T) {
	dir, root := t.TempDir(), t.TempDir()
	for i := 0; i < RuntimeScanEntries+200; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%05d", i)), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeRuntimeRepo(t, root, "https://git.example/"+strings.Repeat("x", runtimeConfigBytes))
	if err := AddBrowseRoot(dir, "dev", root); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	_, repos, truncated := ScanRuntimeRoots(ctx, dir)
	if len(repos) != 1 || repos[0].Origin != "" || !truncated || time.Since(start) > 3*time.Second {
		t.Fatalf("大目录扫描未受限：%+v %v %s", repos, truncated, time.Since(start))
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	_, repos, truncated = ScanRuntimeRoots(ctx2, dir)
	if len(repos) != 0 || !truncated {
		t.Fatal("已取消扫描仍读取目录")
	}
}

func TestRuntimeScanMarksOversizedConfig(t *testing.T) {
	dir, root := t.TempDir(), t.TempDir()
	writeRuntimeRepo(t, root, "https://git.example/"+strings.Repeat("x", runtimeConfigBytes))
	if err := AddBrowseRoot(dir, "dev", root); err != nil {
		t.Fatal(err)
	}
	_, repos, truncated := ScanRuntimeRoots(context.Background(), dir)
	if len(repos) != 1 || repos[0].Origin != "" || !truncated {
		t.Fatalf("配置超限没有标记不完整报告：%+v truncated=%t", repos, truncated)
	}
}

func TestRuntimeScanWorktreeAndConfigInclude(t *testing.T) {
	dir, root := t.TempDir(), t.TempDir()
	writeRuntimeRepo(t, filepath.Join(root, "main"), "ssh://git@git.example/org/repo")
	work := filepath.Join(root, "work")
	gitdir := filepath.Join(root, "main", ".git", "worktrees", "work")
	if err := os.MkdirAll(gitdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, ".git"), []byte("gitdir: "+gitdir), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gitdir, "commondir"), []byte("../.."), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "dev", root); err != nil {
		t.Fatal(err)
	}
	_, repos, _ := ScanRuntimeRoots(context.Background(), dir)
	if len(repos) != 2 || repos[0].Origin != "git.example/org/repo" || repos[1].Origin != "git.example/org/repo" {
		t.Fatalf("worktree 未识别：%+v", repos)
	}
	outside := filepath.Join(t.TempDir(), "secret-config")
	if err := os.WriteFile(outside, []byte("[remote \"origin\"]\nurl=https://secret.example/leak\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main", ".git", "config"), []byte("[include]\npath="+filepath.ToSlash(outside)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, repos, _ = ScanRuntimeRoots(context.Background(), dir)
	for _, repo := range repos {
		if repo.Origin != "" {
			t.Fatal("读取了 include 配置")
		}
	}
}
