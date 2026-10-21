package fileaccess

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestThreadAttachments(t *testing.T) {
	data, root, outside := t.TempDir(), t.TempDir(), t.TempDir()
	if err := AddBrowseRoot(data, "dev", root); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"report.txt", "space name.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("report"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	config := "[remote \"origin\"]\n url = https://user:secret@example.com:443/team/repo.git?token=secret#fragment\n"
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	content := "结果 `report.txt` 和 `space name.txt`，重复 " + filepath.Join(root, "report.txt") + "。 commit ABCDEF0123456789 commit 1234567 commit 123456 commit 12345678901234567890123456789012345678901 " + filepath.Join(outside, "outside.txt") + " `missing.txt`"
	refs, err := ParseThreadAttachments(data, "node", root, content)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 4 {
		t.Fatalf("attachments=%+v", refs)
	}
	for _, ref := range refs {
		if ref.Kind == "commit" {
			if ref.Repo != "example.com/team/repo.git" || strings.Contains(ref.Repo, "secret") {
				t.Fatalf("origin=%q", ref.Repo)
			}
			continue
		}
		if ref.NodeID != "node" || ref.RootID != "dev" || ref.AccessStatus != "available" {
			t.Fatalf("file=%+v", ref)
		}
	}
	if err := ValidateThreadWorkingDirectory(data, root); err != nil {
		t.Fatal(err)
	}
	if err := ValidateThreadWorkingDirectory(data, outside); err == nil {
		t.Fatal("accepted outside working directory")
	}
	if err := ValidateThreadWorkingDirectory(data, filepath.Join(root, "report.txt")); err == nil {
		t.Fatal("accepted file as working directory")
	}
}

func TestThreadAttachmentsSkipEscapesAndMissingOrigin(t *testing.T) {
	data, root, outside := t.TempDir(), t.TempDir(), t.TempDir()
	if err := AddBrowseRoot(data, "root", root); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("需要符号链接权限")
		}
		t.Fatal(err)
	}
	refs, err := ParseThreadAttachments(data, "node", root, "`escape/secret` `../secret` commit 1234567 `.`")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 0 {
		t.Fatalf("escaped attachments=%+v", refs)
	}
	if err := ValidateThreadWorkingDirectory(data, filepath.Join(root, "escape")); err == nil {
		t.Fatal("accepted escaping directory")
	}
}

func TestThreadCommitUsesNearestRepositoryAndSubdirectory(t *testing.T) {
	data, root := t.TempDir(), t.TempDir()
	if err := AddBrowseRoot(data, "root", root); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{".git", "sub/child", "sub/.git"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("[remote \"origin\"]\nurl=git@example.com:outer/repo.git\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	refs, err := ParseThreadAttachments(data, "node", filepath.Join(root, "sub", "child"), "commit 1234567")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 0 {
		t.Fatalf("inherited outer origin: %+v", refs)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", ".git", "config"), []byte("[remote \"origin\"]\nurl=git@example.com:inner/repo.git\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	refs, err = ParseThreadAttachments(data, "node", filepath.Join(root, "sub", "child"), "commit 1234567")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].Repo != "example.com/inner/repo.git" {
		t.Fatalf("origin: %+v", refs)
	}
}
