package replay

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"baton/internal/privatefile"
	"github.com/gofrs/flock"
)

type Config struct {
	Transcript string            `json:"transcript"`
	StateDir   string            `json:"state_dir"`
	Bindings   map[string]string `json:"bindings"`
	Gates      []string          `json:"gates,omitempty"`
}

type Failure struct {
	Entry    int             `json:"entry"` // NDJSON 中从 1 开始的行号。
	Process  int             `json:"process"`
	Label    string          `json:"label"`
	Expected json.RawMessage `json:"expected"`
	Actual   json.RawMessage `json:"actual"`
	Reason   string          `json:"reason"`
}

type Exit struct {
	Code   int
	Signal string
}

type state struct {
	Process  int            `json:"process"`
	Captures map[string]any `json:"captures"`
}

// LoadConfig 的相对路径以可执行文件所在目录为基准，与 Agent 的 cwd 无关。
func LoadConfig(executable string) (Config, error) {
	var c Config
	f, err := os.Open(executable + ".replay.json")
	if err != nil {
		return c, err
	}
	defer f.Close()
	d := json.NewDecoder(f)
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return c, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return c, errors.New("配置只能包含一个 JSON 对象")
	}
	if c.Transcript == "" || c.StateDir == "" {
		return c, errors.New("配置缺少 transcript 或 state_dir")
	}
	if !filepath.IsAbs(c.Transcript) {
		c.Transcript = filepath.Join(filepath.Dir(executable), c.Transcript)
	}
	if !filepath.IsAbs(c.StateDir) {
		c.StateDir = filepath.Join(filepath.Dir(executable), c.StateDir)
	}
	return c, nil
}

func updateState(ctx context.Context, dir string, fn func(*state) error) error {
	lock := flock.New(filepath.Join(dir, "state.lock"))
	ok, err := lock.TryLockContext(ctx, 5*time.Millisecond)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("无法锁定回放状态")
	}
	defer lock.Unlock()
	s := state{Captures: map[string]any{}}
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		d := json.NewDecoder(strings.NewReader(string(raw)))
		d.UseNumber()
		if err := d.Decode(&s); err != nil {
			return err
		}
		if err := d.Decode(new(any)); err != io.EOF {
			return errors.New("回放状态含多余内容")
		}
		if s.Captures == nil || s.Process < 0 {
			return errors.New("回放状态损坏")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := fn(&s); err != nil {
		return err
	}
	raw, err = json.Marshal(s)
	if err != nil {
		return err
	}
	return privatefile.WriteFile(filepath.Join(dir, "state.json"), raw)
}

// GatePath 对 label 做文件名转义，使含冒号和斜杠的方法名能在 Windows 使用。
func GatePath(dir, label, phase string) string {
	return filepath.Join(dir, url.QueryEscape(label)+"."+phase)
}

func WaitReached(ctx context.Context, dir, label string) error {
	return waitFile(ctx, GatePath(dir, label, "reached"))
}

func Release(dir, label string) error {
	return os.WriteFile(GatePath(dir, label, "release"), nil, 0600)
}

func waitFile(ctx context.Context, path string) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return nil
		} else if !os.IsNotExist(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

type inputFrame struct {
	raw json.RawMessage
	err error
}

// Serve 执行一次进程。调用方负责按 Exit 退出；输入应可关闭以结束读协程。
func Serve(ctx context.Context, c Config, args []string, stdin io.Reader, stdout, stderr io.Writer) (exit Exit, failure error) {
	if err := os.MkdirAll(c.StateDir, 0700); err != nil {
		return Exit{Code: 1}, err
	}
	process, line, label := 0, 1, ""
	var expected, actual json.RawMessage
	defer func() {
		if failure == nil {
			return
		}
		exit = Exit{Code: 1}
		f := Failure{Entry: line, Process: process, Label: label, Expected: expected, Actual: actual, Reason: failure.Error()}
		raw, err := json.MarshalIndent(f, "", "  ")
		if err == nil {
			err = privatefile.WriteFile(filepath.Join(c.StateDir, "failure.json"), raw)
		}
		if err != nil {
			failure = errors.Join(failure, fmt.Errorf("写 failure.json: %w", err))
		}
	}()
	if err := updateState(ctx, c.StateDir, func(s *state) error {
		s.Process++
		process = s.Process
		return nil
	}); err != nil {
		return Exit{}, err
	}
	f, err := os.Open(c.Transcript)
	if err != nil {
		return Exit{}, err
	}
	t, err := Read(f)
	f.Close()
	if err != nil {
		return Exit{}, err
	}
	if c.Bindings, err = declaredBindings(t.Header, c.Bindings); err != nil {
		return Exit{}, err
	}
	gates := map[string]bool{}
	for _, name := range c.Gates {
		if _, err := t.index(name, false); err != nil {
			return Exit{}, err
		}
		gates[name] = true
	}
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	frames := make(chan inputFrame)
	go func() {
		s := bufio.NewScanner(stdin)
		s.Buffer(make([]byte, 4096), MaxFrame)
		for s.Scan() {
			raw := append(json.RawMessage(nil), s.Bytes()...)
			if !json.Valid(raw) {
				raw, _ = json.Marshal(map[string]string{"text": string(raw)})
			}
			select {
			case frames <- inputFrame{raw: raw}:
			case <-readCtx.Done():
				return
			}
		}
		err := s.Err()
		if err == nil {
			err = io.EOF
		}
		select {
		case frames <- inputFrame{err: err}:
		case <-readCtx.Done():
		}
	}()
	read := func() (json.RawMessage, error) {
		select {
		case frame := <-frames:
			return frame.raw, frame.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	checkEnd := func() error {
		var err error
		actual, err = read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		return errors.New("转录结束后收到多余帧")
	}
	seen := false
	for i, e := range t.Entries {
		if e.Process != process {
			continue
		}
		seen, line, label, expected, actual = true, i+2, e.Label, e.Frame, nil
		if gates[e.Label] {
			if err := os.WriteFile(GatePath(c.StateDir, e.Label, "reached"), nil, 0600); err != nil {
				return Exit{}, err
			}
			if err := waitFile(ctx, GatePath(c.StateDir, e.Label, "release")); err != nil {
				return Exit{}, err
			}
		}
		if e.Type == "expect_outbound" {
			var err error
			actual, err = read()
			if err != nil {
				return Exit{}, fmt.Errorf("等待出站帧: %w", err)
			}
		}
		var frame json.RawMessage
		var text, path string
		err := updateState(ctx, c.StateDir, func(s *state) error {
			var err error
			switch e.Type {
			case "process_start":
				want, got := e.Args, args
				if want == nil {
					want = []string{}
				}
				if got == nil {
					got = []string{}
				}
				expected, _ = json.Marshal(want)
				actual, _ = json.Marshal(got)
				return Match(expected, actual, c.Bindings, s.Captures)
			case "expect_outbound":
				return Match(e.Frame, actual, c.Bindings, s.Captures)
			case "emit_inbound":
				frame, err = Expand(e.Frame, c.Bindings, s.Captures)
			case "emit_stderr":
				text, err = expandString(e.Text, c.Bindings, s.Captures)
			case "native_history":
				path, err = expandString(e.Path, c.Bindings, s.Captures)
				if err == nil {
					text, err = expandHistory(e.Append, c.Bindings, s.Captures)
				}
			}
			return err
		})
		if err != nil {
			return Exit{}, err
		}
		// 不持有状态锁等待协议 IO，其他进程仍能领取编号并读取捕获。
		switch e.Type {
		case "emit_inbound":
			var plain map[string]json.RawMessage
			if json.Unmarshal(frame, &plain) == nil && len(plain) == 1 && plain["text"] != nil {
				if err := json.Unmarshal(plain["text"], &text); err != nil {
					return Exit{}, err
				}
			} else {
				text = string(frame)
			}
			_, err = fmt.Fprintln(stdout, text)
		case "emit_stderr":
			_, err = fmt.Fprintln(stderr, text)
		case "native_history":
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				return Exit{}, err
			}
			file, openErr := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if openErr != nil {
				return Exit{}, openErr
			}
			_, writeErr := io.WriteString(file, text)
			err = errors.Join(writeErr, file.Close())
		}
		if err != nil {
			return Exit{}, err
		}
		if e.Type == "runtime_exit" {
			if e.Signal == "" && e.Code == 0 {
				if err := checkEnd(); err != nil {
					return Exit{}, err
				}
			}
			return Exit{Code: e.Code, Signal: e.Signal}, nil
		}
	}
	if !seen {
		return Exit{}, fmt.Errorf("转录没有进程 %d", process)
	}
	line, label, expected = len(t.Entries)+2, "", nil
	return Exit{}, checkEnd()
}

func expandHistory(text string, bindings map[string]string, captures map[string]any) (string, error) {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if json.Valid([]byte(line)) {
			raw, err := Expand(json.RawMessage(line), bindings, captures)
			if err != nil {
				return "", err
			}
			lines[i] = string(raw)
		} else {
			value, err := expandString(line, bindings, captures)
			if err != nil {
				return "", err
			}
			lines[i] = value
		}
	}
	return strings.Join(lines, "\n"), nil
}

// declaredBindings 只保留转录声明的绑定；未声明时沿用配置，兼容旧转录。
func declaredBindings(h Header, configured map[string]string) (map[string]string, error) {
	if len(h.Bindings) == 0 {
		return configured, nil
	}
	out := make(map[string]string, len(h.Bindings))
	for _, token := range h.Bindings {
		v, ok := configured[token]
		if !ok {
			return nil, fmt.Errorf("配置缺少转录声明的绑定 %s", token)
		}
		out[token] = v
	}
	return out, nil
}
