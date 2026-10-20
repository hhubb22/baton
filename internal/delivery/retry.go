// Package delivery 提供持久投递的有界退避规则。
package delivery

import (
	"math"
	"math/rand/v2"
	"time"
)

const MaxDelay = 30 * time.Second

// NextAttempt 使用调用方取得的持久存储时钟，attempt 从 1 开始。
func NextAttempt(now time.Time, attempt int, minimum time.Duration) time.Time {
	return now.Add(delay(attempt, minimum, rand.Float64()))
}

func delay(attempt int, minimum time.Duration, fraction float64) time.Duration {
	if minimum <= 0 {
		minimum = time.Second
	}
	minimum = min(minimum, MaxDelay)
	base := minimum
	for i := 1; i < attempt && base < MaxDelay; i++ {
		base = min(base*2, MaxDelay)
	}
	low := max(minimum, base-base/5)
	if math.IsNaN(fraction) || fraction < 0 {
		fraction = 0
	}
	fraction = min(fraction, 1)
	return low + time.Duration(float64(base-low)*fraction)
}
