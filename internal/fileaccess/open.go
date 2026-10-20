package fileaccess

import "os"

// OpenInRoot 以只读方式打开根目录内的目标，空路径表示根目录。
// Unix 使用非阻塞打开，避免没有写端的 FIFO 阻塞；调用方须用返回文件的 Stat 检查允许的类型。
func OpenInRoot(root *os.Root, rel string) (*os.File, error) {
	if rel == "" {
		rel = "."
	}
	return openInRoot(root, rel)
}
