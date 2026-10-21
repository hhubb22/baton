package fileaccess

import (
	"errors"
	"path/filepath"
)

// ValidateThreadWorkingDirectory 核对已有目录及实际打开时的授权边界。
func ValidateThreadWorkingDirectory(dataDir, directory string) error {
	if !filepath.IsAbs(directory) {
		return errors.New("工作目录必须是绝对路径")
	}
	roots, err := ListBrowseRoots(dataDir)
	if err != nil {
		return err
	}
	for _, root := range roots {
		rel, err := filepath.Rel(root.Path, directory)
		if err != nil || !filepath.IsLocal(rel) {
			continue
		}
		f, err := openAuthorized(roots, root.ID, filepath.ToSlash(rel))
		if err != nil {
			continue
		}
		info, err := f.Stat()
		_ = f.Close()
		if err == nil && info.IsDir() {
			return nil
		}
	}
	return errors.New("工作目录不存在或位于登记目录之外")
}
