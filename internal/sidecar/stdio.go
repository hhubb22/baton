// Package sidecar 提供 Node sidecar 的发现、有限容量 stdio 和进程树管理。
package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"unicode/utf8"
)

const MaxFrame = 192 << 10

// Serve 使用带请求编号的 JSON 行，最多允许 8 个并发请求。stdout 只承载协议帧。
func Serve(ctx context.Context, input io.Reader, output io.Writer, handle func(context.Context, json.RawMessage) any) error {
	ctx, cancel := context.WithCancel(ctx)
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), MaxFrame+2)
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if end := bytes.IndexByte(data, '\n'); end >= 0 {
			return end + 1, data[:end], nil
		}
		if atEOF && len(data) > 0 {
			return 0, nil, errors.New("sidecar 帧缺少换行符")
		}
		return 0, nil, nil
	})
	var writes sync.Mutex
	var workers sync.WaitGroup
	defer workers.Wait()
	defer cancel()
	slots := make(chan struct{}, 8)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) > MaxFrame || !utf8.Valid(raw) {
			return errors.New("sidecar 帧超过限制或编码无效")
		}
		var frame struct {
			ID      int64           `json:"id"`
			Request json.RawMessage `json:"request"`
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if d.Decode(&frame) != nil || frame.ID <= 0 || len(frame.Request) == 0 || d.Decode(new(any)) != io.EOF {
			return errors.New("sidecar 帧无效")
		}
		select {
		case slots <- struct{}{}:
		default:
			return errors.New("sidecar 并发请求超过限制")
		}
		workers.Add(1)
		go func(id int64, request json.RawMessage) {
			defer workers.Done()
			defer func() { <-slots }()
			result := handle(ctx, request)
			raw, err := json.Marshal(struct {
				ID     int64 `json:"id"`
				Result any   `json:"result"`
			}{id, result})
			if err != nil || len(raw) > MaxFrame {
				return
			}
			writes.Lock()
			defer writes.Unlock()
			_, _ = output.Write(append(raw, '\n'))
		}(frame.ID, frame.Request)
	}
	return scanner.Err()
}
