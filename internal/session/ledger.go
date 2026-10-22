package session

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"modernc.org/sqlite"
)

var (
	// ErrHistoryMissing 表示已知 Session 的账本文件不存在。调用方不能新建空账本假装恢复成功。
	ErrHistoryMissing = errors.New("Session 历史缺失")
	// ErrHistoryIncompatible 表示账本已损坏或不是本组件能读取的格式。
	ErrHistoryIncompatible = errors.New("Session 历史已损坏或不兼容")
	// ErrHistoryUnread 不是损坏证据；调用方应有界重试，持续失败后报告历史待核实。
	ErrHistoryUnread = errors.New("Session 历史这次没有读成")
)

// classifyLedgerErr 只把文件损坏当成不兼容，其余读取失败交给调用方有界重试。
func classifyLedgerErr(err error) error {
	if err == nil {
		return nil
	}
	var sqErr *sqlite.Error
	if errors.As(err, &sqErr) {
		switch sqErr.Code() & 0xff {
		case 11, 26: // SQLITE_CORRUPT, SQLITE_NOTADB
			return fmt.Errorf("%w: %w", ErrHistoryIncompatible, err)
		}
	}
	return fmt.Errorf("%w: %w", ErrHistoryUnread, err)
}

func sqliteDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path), OmitHost: !filepath.IsAbs(path)}
	if filepath.IsAbs(path) && !strings.HasPrefix(u.Path, "/") {
		u.Path = "/" + u.Path
	}
	u.RawQuery = "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_txlock=immediate"
	return u.String()
}

func chmodDB(path string) error {
	for _, name := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(name); err != nil {
			if name != path && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		if err := os.Chmod(name, 0o600); err != nil {
			if name != path && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
	}
	return nil
}
