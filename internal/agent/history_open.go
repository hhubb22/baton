package agent

import (
	"os"

	"baton/internal/fileaccess"
)

// OpenHistoryFile 在授权根目录内打开普通文件，拒绝管道、设备和目录。
func OpenHistoryFile(root *os.Root, rel string) (*os.File, error) {
	f, err := fileaccess.OpenInRoot(root, rel)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, ErrHistoryUnread
	}
	return f, nil
}
