//go:build windows

package fileaccess

import "os"

func openInRoot(root *os.Root, rel string) (*os.File, error) {
	return root.OpenFile(rel, os.O_RDONLY, 0)
}
