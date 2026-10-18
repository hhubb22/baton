package fileaccess

import (
	"fmt"
	"os"

	"baton/internal/protocol"
	"baton/internal/task"
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
		return openInRoot(opened, normalized)
	}
	return nil, &BrowseError{Code: protocol.FileCodeRootForbidden, Message: "未授权的目录"}
}

// CheckArtifacts 只打开并核对普通文件，不读取内容、不下载 URL，也不信任调用方的访问状态。
func CheckArtifacts(dir, nodeID string, refs []task.ArtifactRef) ([]task.ResultRef, string) {
	if len(refs) == 0 {
		return nil, ""
	}
	roots, configErr := ListBrowseRoots(dir)
	results := make([]task.ResultRef, 0, len(refs))
	first := ""
	for i, ref := range refs {
		reason := ""
		switch {
		case ref.NodeID != nodeID || nodeID == "":
			reason = "other_node: 引用仅属于其他节点，不能当作已交付"
		case configErr != nil:
			reason = "unavailable: 授权目录配置无法使用"
		default:
			file, err := openAuthorized(roots, ref.RootID, ref.Path)
			if err == nil {
				info, statErr := file.Stat()
				_ = file.Close()
				err = statErr
				if err == nil && !info.Mode().IsRegular() {
					err = &BrowseError{Code: protocol.FileCodeUnsupported, Message: "产物必须是普通文件"}
				}
			}
			if err != nil {
				code, message := classifyOpen(err)
				reason = code + ": " + message
			}
		}
		status := task.AccessAvailable
		if reason != "" {
			status = task.AccessUnavailable
			if first == "" {
				first = fmt.Sprintf("required_artifacts[%d]: %s", i, reason)
			}
		}
		results = append(results, task.ResultRef{NodeID: ref.NodeID, StorageRef: "root:" + ref.RootID, ResourceID: ref.Path, AccessStatus: status, Note: reason})
	}
	return results, first
}
