package agent

import (
	"context"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// LiveBuffer 保留最近的纯文本，超限丢弃旧片段并报告缺口。
type LiveBuffer struct {
	mu   sync.Mutex
	text string
	gap  bool
}

func (b *LiveBuffer) Append(text string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	text = PlainText(text)
	const limit = 256 * 1024
	if len(text) > limit {
		text = text[len(text)-limit:]
		b.gap = true
	}
	b.text += text
	if len(b.text) > limit {
		b.text = b.text[len(b.text)-limit:]
		b.gap = true
	}
	for !utf8.ValidString(b.text) && len(b.text) > 0 {
		b.text = b.text[1:]
	}
}

func (b *LiveBuffer) Drain() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	text, gap := b.text, b.gap
	b.text, b.gap = "", false
	return text, gap
}

// PlainText 移除控制字符，显示层仍须使用文本节点。
func PlainText(text string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == '\u202e' || r == '\u202d' {
			return -1
		}
		return r
	}, strings.ToValidUTF8(text, "�"))
}

type LiveAdapter interface{ DrainLive() (string, bool) }
type InputAdapter interface {
	Supplement(context.Context, string, string) error
}

func (b *LiveBuffer) MarkGap() { b.mu.Lock(); b.gap = true; b.mu.Unlock() }
