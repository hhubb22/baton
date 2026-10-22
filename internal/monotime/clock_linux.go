//go:build linux

package monotime

import (
	"errors"
	"time"

	"golang.org/x/sys/unix"
)

var errNoClock = errors.New("无法读取单调时钟")

// readMono 使用 CLOCK_BOOTTIME。它不受墙上时钟跳变影响，并且计入系统暂停。
func readMono() (time.Duration, error) {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &ts); err != nil {
		return 0, errNoClock
	}
	return time.Duration(ts.Nano()), nil
}
