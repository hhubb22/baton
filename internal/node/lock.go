package node

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/gofrs/flock"
)

// ErrDataDirBusy 表示另一个 batond 已经占用这个数据目录。
var ErrDataDirBusy = errors.New("已有 batond 使用该数据目录")

func acquireDataLock(dir string) (func(), error) {
	if err := PrepareDataDir(dir); err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(dir, "batond.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return nil, errors.New("无法锁定节点数据目录")
	}
	if !ok {
		return nil, ErrDataDirBusy
	}
	_ = os.Chmod(filepath.Join(dir, "batond.lock"), 0o600)
	return func() { _ = lock.Unlock() }, nil
}
