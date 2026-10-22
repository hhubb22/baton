package fileaccess

import (
	"os"

	"baton/internal/protocol"
)

// openAuthorized 与浏览共用目录登记、路径规范化及实际打开时的 os.Root 边界。
func openAuthorized(roots []BrowseRoot, rootID, rel string) (*os.File, error) {
	if err := CheckBrowseQuery(rootID, rel, ""); err != nil {
		return nil, err
	}
	for _, root := range roots {
		if root.ID != rootID {
			continue
		}
		opened, err := openConfiguredRoot(root.Path)
		if err != nil {
			return nil, err
		}
		defer opened.Close()
		normalized, _ := normalizeRelative(rel)
		return OpenInRoot(opened, normalized)
	}
	return nil, &BrowseError{Code: protocol.FileCodeRootForbidden, Message: "未授权的目录"}
}
