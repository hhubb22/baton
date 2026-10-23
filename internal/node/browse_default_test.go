package node

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBrowseDefaultHome(t *testing.T) {
	home := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	} else {
		t.Setenv("HOME", home)
	}
	dir := filepath.Join(t.TempDir(), "node")
	EnsureDefaultBrowseRoot("")
	EnsureDefaultBrowseRoot(dir)
	roots, err := ListBrowseRoots(dir)
	real, _ := filepath.EvalSymlinks(home)
	if err != nil || len(roots) != 1 || roots[0].Path != real {
		t.Fatalf("未登记主目录: %+v %v", roots, err)
	}
	EnsureDefaultBrowseRoot(dir)
	if err := RemoveBrowseRootPath(dir, real); err != nil {
		t.Fatal(err)
	}
	EnsureDefaultBrowseRoot(dir)
	roots, err = ListBrowseRoots(dir)
	if err != nil || len(roots) != 0 {
		t.Fatalf("已清空的目录又被添加: %+v %v", roots, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "browse-roots.json"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	EnsureDefaultBrowseRoot(dir)
	raw, _ := os.ReadFile(filepath.Join(dir, "browse-roots.json"))
	if string(raw) != "invalid" {
		t.Fatal("已有配置被覆盖")
	}
}
