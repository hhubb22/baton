//go:build unix

package agent

import (
	"os"
	"syscall"
)

func openHistoryFile(root *os.Root, rel string) (*os.File, error) {
	return root.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
