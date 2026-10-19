package agent

import (
	"baton/internal/protocol"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// ReadJSONLHistory 固定本次文件长度，逐行读取；正文只保留 8 KiB 前缀。
func ReadJSONLHistory(ctx context.Context, f *os.File, binding, cursor string, limit int, includeHeader bool, validate func([]byte) error) (protocol.SessionHistoryPage, error) {
	var empty protocol.SessionHistoryPage
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return empty, ErrHistoryUnread
	}
	r := bufio.NewReaderSize(io.LimitReader(f, info.Size()), 8192)
	header, digest, size, err := browserLineLimit(ctx, r, 256*1024)
	if err != nil || size > int64(len(header)) {
		return empty, ErrHistoryUnread
	}
	if err := validate(header); err != nil {
		return empty, err
	}
	pager, err := NewHistoryPager(fmt.Sprintf("%s:%x", binding, digest), cursor, limit)
	if err != nil {
		return empty, err
	}
	if includeHeader {
		more, err := pager.Add(header, digest, size, binding+":0")
		if err != nil {
			return empty, err
		}
		if !more {
			return pager.Finish("")
		}
	}
	offset := size
	for {
		line, sum, n, readErr := browserLine(ctx, r)
		if ctx.Err() != nil {
			return empty, ctx.Err()
		}
		if errors.Is(readErr, io.EOF) {
			code := ""
			if n > 0 {
				code = "history_incomplete"
			}
			return pager.Finish(code)
		}
		if readErr != nil {
			return empty, ErrHistoryUnread
		}
		if len(bytes.TrimSpace(line)) > 0 {
			if n <= int64(len(line)) && !json.Valid(line) {
				return pager.Finish("history_invalid")
			}
			more, err := pager.Add(line, sum, n, fmt.Sprintf("%s:%d", binding, offset))
			if err != nil {
				return empty, err
			}
			if !more {
				return pager.Finish("")
			}
		}
		offset += n
	}
}

// browserLine 的内存上限与原生行长度无关，完整行只参与摘要和字节计数。
func browserLine(ctx context.Context, r *bufio.Reader) ([]byte, [32]byte, int64, error) {
	return browserLineLimit(ctx, r, 8192)
}

func browserLineLimit(ctx context.Context, r *bufio.Reader, capture int) ([]byte, [32]byte, int64, error) {
	var prefix []byte
	var size int64
	h := sha256.New()
	for {
		if err := ctx.Err(); err != nil {
			return nil, [32]byte{}, 0, err
		}
		part, err := r.ReadSlice('\n')
		size += int64(len(part))
		h.Write(part)
		if len(prefix) < capture {
			prefix = append(prefix, part[:min(len(part), capture-len(prefix))]...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		var sum [32]byte
		copy(sum[:], h.Sum(nil))
		return prefix, sum, size, err
	}
}
