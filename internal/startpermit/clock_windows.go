//go:build windows

package startpermit

import (
	"errors"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errNoClock = errors.New("无法读取单调时钟")

var (
	kernel32               = windows.NewLazySystemDLL("kernel32.dll")
	procQueryInterruptTime = kernel32.NewProc("QueryInterruptTime")
)

// readMono 使用 QueryInterruptTime。它的计数包含系统睡眠和休眠，单位是 100 纳秒。
func readMono() (time.Duration, error) {
	var ticks uint64
	r, _, _ := procQueryInterruptTime.Call(uintptr(unsafe.Pointer(&ticks)))
	if r == 0 {
		return 0, errNoClock
	}
	return time.Duration(ticks) * 100 * time.Nanosecond, nil
}
