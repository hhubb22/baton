//go:build !linux && !darwin && !windows

package startpermit

import (
	"errors"
	"time"
)

var errNoClock = errors.New("无法读取单调时钟")

func readMono() (time.Duration, error) {
	return 0, errNoClock
}
