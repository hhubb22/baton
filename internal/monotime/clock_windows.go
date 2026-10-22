//go:build windows

package monotime

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errNoClock = errors.New("无法读取单调时钟")

var (
	realtime               = windows.NewLazySystemDLL("api-ms-win-core-realtime-l1-1-1.dll")
	procQueryInterruptTime = realtime.NewProc("QueryInterruptTime")
)

// readMono 使用 QueryInterruptTime。它的计数包含系统睡眠和休眠，单位是 100 纳秒。
func readMono() (time.Duration, error) {
	return readInterruptTime(procQueryInterruptTime)
}

func readInterruptTime(proc *windows.LazyProc) (time.Duration, error) {
	if err := proc.Find(); err != nil {
		return 0, fmt.Errorf("%w: %w", errNoClock, err)
	}
	var ticks uint64
	// QueryInterruptTime 没有返回值，Call 的寄存器值和 lastErr 不表示成功或失败。
	proc.Call(uintptr(unsafe.Pointer(&ticks)))
	return time.Duration(ticks) * 100 * time.Nanosecond, nil
}
