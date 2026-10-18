package node

import (
	"baton/internal/fileaccess"
	"baton/internal/protocol"
)

type BrowseRoot = fileaccess.BrowseRoot
type BrowseError = fileaccess.BrowseError

func browseFail(result protocol.FileResult, code, message string) protocol.FileResult {
	return fileaccess.Fail(result, code, message)
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
