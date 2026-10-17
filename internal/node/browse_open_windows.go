//go:build windows

package node

import "os"

func openInRoot(root *os.Root, rel string) (*os.File, error) {
	name := rel
	if name == "" {
		name = "."
	}
	return root.OpenFile(name, os.O_RDONLY, 0)
}
