package agent

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLiveBufferNeverBackpressuresOrGrowsWithoutLimit(t *testing.T) {
	var b LiveBuffer
	for i := 0; i < 1000; i++ {
		b.Append(strings.Repeat("输出", 1000))
	}
	text, gap := b.Drain()
	if !gap || len(text) > 256*1024 || !utf8.ValidString(text) {
		t.Fatal("缓存无界或没有报告缺口")
	}
	if text, gap = b.Drain(); text != "" || gap {
		t.Fatal("重复消费输出")
	}
}
