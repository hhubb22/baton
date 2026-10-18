package pi

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

// Pi history and protocol frames are local data, not 256 KiB relay messages.
const maxFrame = 32 * 1024 * 1024

func readFrames(r io.Reader, consume func([]byte) error) error {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 64*1024), maxFrame)
	s.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			return i + 1, bytes.TrimSuffix(data[:i], []byte{'\r'}), nil
		}
		if atEOF && len(data) > 0 {
			return 0, nil, errors.New("unterminated Pi JSONL frame")
		}
		return 0, nil, nil
	})
	for s.Scan() {
		if len(bytes.TrimSpace(s.Bytes())) == 0 {
			continue
		}
		if err := consume(s.Bytes()); err != nil {
			return err
		}
	}
	if s.Err() != nil {
		return errors.New("Pi JSONL frame could not be read (limit 32 MiB)")
	}
	return nil
}
