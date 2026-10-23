package node

import (
	"os"

	"baton/internal/fileaccess"
	"baton/internal/protocol"
)

type BrowseRoot = fileaccess.BrowseRoot
type BrowseError = fileaccess.BrowseError

func browseFail(result protocol.FileResult, code, message string) protocol.FileResult {
	return fileaccess.Fail(result, code, message)
}

func HasBrowseRootsConfig(dir string) bool { return fileaccess.HasBrowseRootsConfig(dir) }
func AddBrowseRootPath(dir, path string) (BrowseRoot, error) {
	return fileaccess.AddBrowseRootPath(dir, path)
}
func RemoveBrowseRootPath(dir, target string) error {
	return fileaccess.RemoveBrowseRootPath(dir, target)
}

// EnsureDefaultBrowseRoot 仅在首次配置时登记主目录，保留用户已保存的空目录列表。
func EnsureDefaultBrowseRoot(dir string) {
	if dir == "" || HasBrowseRootsConfig(dir) {
		return
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		_, _ = AddBrowseRootPath(dir, home)
	}
}

func AddBrowseRoot(dir, id, path string) error         { return fileaccess.AddBrowseRoot(dir, id, path) }
func RemoveBrowseRoot(dir, id string) error            { return fileaccess.RemoveBrowseRoot(dir, id) }
func ListBrowseRoots(dir string) ([]BrowseRoot, error) { return fileaccess.ListBrowseRoots(dir) }
func CheckBrowseQuery(root, path, cursor string) error {
	return fileaccess.CheckBrowseQuery(root, path, cursor)
}
func Browse(dir string, req protocol.FileRequest) protocol.FileResult {
	return fileaccess.Browse(dir, req)
}
