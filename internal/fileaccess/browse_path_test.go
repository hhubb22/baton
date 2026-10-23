package fileaccess

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"baton/internal/protocol"
)

func TestBrowseRootPaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")
	if HasBrowseRootsConfig(dir) {
		t.Fatal("新目录已有配置")
	}
	var added []BrowseRoot
	for _, name := range []string{"Repo", "repo", "中文", "123", strings.Repeat("x", 100)} {
		path := filepath.Join(t.TempDir(), name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		root, err := AddBrowseRootPath(dir, "  "+path+"  ")
		if err != nil {
			t.Fatal(err)
		}
		if !rootIDPattern.MatchString(root.ID) || len(root.ID) > 48 {
			t.Fatalf("无效标识: %s", root.ID)
		}
		again, err := AddBrowseRootPath(dir, path+string(filepath.Separator)+".")
		if err != nil || again != root {
			t.Fatalf("未幂等登记: %+v %v", again, err)
		}
		added = append(added, root)
	}
	if added[1].ID != "repo-2" || added[2].ID != "root-" || added[3].ID != "root-123" {
		t.Fatalf("标识生成错误: %+v", added)
	}
	if !HasBrowseRootsConfig(dir) {
		t.Fatal("配置未保存")
	}
	link := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(added[0].Path, link); err == nil {
		root, err := AddBrowseRootPath(dir, link)
		if err != nil || root != added[0] {
			t.Fatalf("符号链接重复登记: %+v %v", root, err)
		}
		if err := RemoveBrowseRootPath(dir, link); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := RemoveBrowseRootPath(dir, added[0].Path); err != nil {
			t.Fatal(err)
		}
	}
	for i, root := range added[1:] {
		target := root.ID
		if i%2 == 0 {
			target = root.Path
		}
		if err := RemoveBrowseRootPath(dir, " "+target+" "); err != nil {
			t.Fatal(err)
		}
	}
	roots, err := ListBrowseRoots(dir)
	if err != nil || len(roots) != 0 || !HasBrowseRootsConfig(dir) {
		t.Fatalf("空配置丢失: %+v %v", roots, err)
	}
	var browseErr *BrowseError
	if err := RemoveBrowseRootPath(dir, "unknown"); !errors.As(err, &browseErr) || browseErr.Code != protocol.FileCodeRootForbidden {
		t.Fatal(err)
	}
	for _, path := range []string{"", "relative", filepath.Join(t.TempDir(), "missing")} {
		if _, err := AddBrowseRootPath(dir, path); !errors.As(err, &browseErr) || browseErr.Code != protocol.FileCodeInvalidPath {
			t.Fatalf("接受无效路径 %q: %v", path, err)
		}
	}
}
