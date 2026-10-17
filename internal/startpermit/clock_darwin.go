//go:build darwin

package startpermit

import (
	"errors"
	"time"

	"golang.org/x/sys/unix"
)

var errNoClock = errors.New("无法读取单调时钟")

// readMono 使用 CLOCK_MONOTONIC。在 Darwin 上该时钟在系统睡眠期间继续增加。
func readMono() (time.Duration, error) {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return 0, errNoClock
	}
	return time.Duration(ts.Nano()), nil
}
