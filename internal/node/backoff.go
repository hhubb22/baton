package node

import (
	"crypto/rand"
	"math/big"
	"time"
)

const (
	// MinBackoff 和 MaxBackoff 是断线重连的等待边界。
	MinBackoff = time.Second
	MaxBackoff = 30 * time.Second
)

// BackoffDelay 计算第 attempt 次重试的等待时间。attempt 从 0 开始，结果落在 1 秒到 30 秒。
// 上限按指数增长到 30 秒，并在该上限的一半到上限之间取抖动；1 秒这一档不再缩短。
func BackoffDelay(attempt int, sample func() float64) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	ceiling := MinBackoff
	for i := 0; i < attempt; i++ {
		if ceiling >= MaxBackoff/2 {
			ceiling = MaxBackoff
			break
		}
		ceiling *= 2
	}
	if ceiling > MaxBackoff {
		ceiling = MaxBackoff
	}
	if ceiling <= MinBackoff {
		return MinBackoff
	}
	if sample == nil {
		sample = cryptoSample
	}
	frac := sample()
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	span := ceiling - ceiling/2
	delay := ceiling/2 + time.Duration(float64(span)*frac)
	if delay < MinBackoff {
		return MinBackoff
	}
	if delay > MaxBackoff {
		return MaxBackoff
	}
	return delay
}

func cryptoSample() float64 {
	n, err := rand.Int(rand.Reader, big.NewInt(1<<53))
	if err != nil {
		return 0
	}
	return float64(n.Int64()) / float64(int64(1)<<53)
}
