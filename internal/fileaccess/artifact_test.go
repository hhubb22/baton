package fileaccess

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"baton/internal/task"
)

func TestArtifactsUseAuthorizedOpenWithoutReadingContent(t *testing.T) {
	dir, root := t.TempDir(), t.TempDir()
	const nodeID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	file := filepath.Join(root, "firmware.bin")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if err := AddBrowseRoot(dir, "build", root); err != nil {
		t.Fatal(err)
	}
	base := task.ArtifactRef{NodeID: nodeID, RootID: "build", Path: "firmware.bin"}
	for _, tc := range []struct{ name, node, root, path, reason string }{
		{"large binary", nodeID, "build", "firmware.bin", ""},
		{"missing", nodeID, "build", "missing.bin", "not_found"},
		{"other node", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "build", "firmware.bin", "other_node"},
		{"unregistered", nodeID, "other", "firmware.bin", "root_forbidden"},
		{"parent", nodeID, "build", "../firmware.bin", "path_escaped"},
		{"absolute", nodeID, "build", file, "path_escaped"},
		{"directory", nodeID, "build", ".", "unsupported_type"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ref := base
			ref.NodeID, ref.RootID, ref.Path = tc.node, tc.root, tc.path
			got, reason := CheckArtifacts(dir, nodeID, []task.ArtifactRef{ref})
			if len(got) != 1 || got[0].ResourceID != tc.path {
				t.Fatalf("引用丢失: %+v", got)
			}
			if tc.reason == "" {
				if reason != "" || got[0].AccessStatus != task.AccessAvailable {
					t.Fatalf("可用产物: %+v %s", got, reason)
				}
			} else if !strings.Contains(reason, tc.reason+":") || got[0].AccessStatus != task.AccessUnavailable {
				t.Fatalf("不可用原因: %+v %s", got, reason)
			}
		})
	}
	if runtime.GOOS == "windows" {
		return
	}
	if err := os.Chmod(file, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(file, 0o600) })
	if _, reason := CheckArtifacts(dir, nodeID, []task.ArtifactRef{base}); !strings.Contains(reason, "没有权限") {
		t.Fatalf("真实权限错误未报告: %s", reason)
	}
	if err := os.Symlink(file, filepath.Join(root, "alias.bin")); err != nil {
		t.Fatal(err)
	}
	base.Path = "alias.bin"
	if _, reason := CheckArtifacts(dir, nodeID, []task.ArtifactRef{base}); !strings.Contains(reason, "path_escaped:") {
		t.Fatalf("符号链接被接受: %s", reason)
	}
}

func TestArtifactsRejectReplacedAuthorizedRoot(t *testing.T) {
	dir, root := t.TempDir(), filepath.Join(t.TempDir(), "build")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "build", root); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(root, root+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), root); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("当前 Windows 用户不能创建符号链接")
		}
		t.Fatal(err)
	}
	refs, reason := CheckArtifacts(dir, "local", []task.ArtifactRef{{NodeID: "local", RootID: "build", Path: "artifact.bin"}})
	if !strings.Contains(reason, "path_escaped:") || refs[0].AccessStatus != task.AccessUnavailable {
		t.Fatalf("登记目录替换未拒绝: %+v %s", refs, reason)
	}
}
