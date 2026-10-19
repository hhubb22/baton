package replay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
)

// RecordConfig 的路径相对可执行文件目录；Bindings 的键与回放配置一致。
type RecordConfig struct {
	AgentBinary  string            `json:"agent_binary"`
	RawDir       string            `json:"raw_dir"`
	ScenarioFile string            `json:"scenario_file"`
	Bindings     map[string]string `json:"bindings"`
	HistoryDirs  []string          `json:"history_dirs,omitempty"`
}

// RawHeader 是 raw-v1 NDJSON 的首行。每个场景共用一个文件，文件顺序即观察顺序。
// Transcript 来自场景 JSON 文件；机器信息只供最终残留扫描，不进入转录。
type RawHeader struct {
	Type       string            `json:"type"`
	Version    int               `json:"version"`
	Transcript Header            `json:"transcript"`
	Bindings   map[string]string `json:"bindings"`
	Hostname   string            `json:"hostname"`
	Username   string            `json:"username"`
}

// RawEntry 的 elapsed_ns 由进程启动时的单调时钟计算，不用于回放等待。
// stdin/stdout/stderr 的 Data 是包含 LF 的原始帧（JSON 中以 base64 保存），EOF
// 前的无 LF 尾部也单独保存。native_history 的 Data 是文件新增的完整 LF 行。
// process_start 使用 Args，runtime_exit 使用 Code/Signal；Process 从 1 连续编号。
type RawEntry struct {
	Type      string   `json:"type"`
	Process   int      `json:"process"`
	ElapsedNS int64    `json:"elapsed_ns"`
	Args      []string `json:"args,omitempty"`
	Data      []byte   `json:"data,omitempty"`
	Path      string   `json:"path,omitempty"`
	Code      int      `json:"code,omitempty"`
	Signal    string   `json:"signal,omitempty"`
}

type RawRecording struct {
	Header  RawHeader
	Entries []RawEntry
}

func ReadRaw(r io.Reader) (RawRecording, error) {
	var raw RawRecording
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(&raw.Header); err != nil {
		return raw, err
	}
	if raw.Header.Type != "raw_start" || raw.Header.Version != 1 {
		return raw, errors.New("不支持的原始录制格式")
	}
	started, ended, clocks := map[int]bool{}, map[int]bool{}, map[int]int64{}
	for {
		var e RawEntry
		if err := d.Decode(&e); err != nil {
			if err == io.EOF {
				break
			}
			return raw, err
		}
		if e.Process < 1 || ended[e.Process] || e.ElapsedNS < clocks[e.Process] {
			return raw, errors.New("原始录制的进程或单调时间无效")
		}
		if e.Type == "process_start" {
			if started[e.Process] || e.Process != len(started)+1 {
				return raw, errors.New("原始进程编号必须连续")
			}
			started[e.Process] = true
		}
		if !started[e.Process] {
			return raw, errors.New("原始录制缺少 process_start")
		}
		switch e.Type {
		case "process_start", "stdin", "stdout", "stderr", "native_history":
		case "runtime_exit":
			if e.Code < 0 {
				return raw, errors.New("原始退出码无效")
			}
			ended[e.Process] = true
		default:
			return raw, fmt.Errorf("未知原始条目 %q", e.Type)
		}
		clocks[e.Process] = e.ElapsedNS
		raw.Entries = append(raw.Entries, e)
	}
	if len(started) == 0 {
		return raw, errors.New("原始录制没有进程")
	}
	// 被 SIGKILL 截断的录制也能规范化，转录末尾的 EOF 由 serve 检查。
	return raw, nil
}

func LoadRecordConfig(executable string) (RecordConfig, error) {
	var c RecordConfig
	f, err := os.Open(executable + ".record.json")
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
		return c, errors.New("录制配置只能包含一个 JSON 对象")
	}
	if c.AgentBinary == "" || c.RawDir == "" || c.ScenarioFile == "" {
		return c, errors.New("录制配置缺少 agent_binary、raw_dir 或 scenario_file")
	}
	for _, p := range []*string{&c.AgentBinary, &c.RawDir, &c.ScenarioFile} {
		if !filepath.IsAbs(*p) {
			*p = filepath.Join(filepath.Dir(executable), *p)
		}
	}
	for i, p := range c.HistoryDirs {
		if !filepath.IsAbs(p) {
			c.HistoryDirs[i] = filepath.Join(filepath.Dir(executable), p)
		}
	}
	if same, err := filepath.EvalSymlinks(c.AgentBinary); err == nil {
		self, _ := filepath.EvalSymlinks(executable)
		if same == self {
			return c, errors.New("真实 Agent 不能是录制器自身")
		}
	}
	return c, nil
}

func temporaryRawDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	temp, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(temp, real)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("原始录制目录必须位于系统临时目录的子目录")
	}
	for parent := real; ; parent = filepath.Dir(parent) {
		if _, err := os.Lstat(filepath.Join(parent, ".git")); err == nil {
			return errors.New("原始录制目录必须在 Git 仓库外")
		} else if !os.IsNotExist(err) {
			return err
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	return nil
}

type recorder struct {
	mu      sync.Mutex
	path    string
	process int
	start   time.Time
	offsets map[string]int64
	cursor  int64
	dirs    []string
}

func (r *recorder) locked(fn func(*os.File) error) error {
	lock := flock.New(r.path + ".lock")
	if err := lock.Lock(); err != nil {
		return err
	}
	defer lock.Unlock()
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	err = fn(f)
	return errors.Join(err, f.Close())
}

func (r *recorder) append(e RawEntry) error {
	e.Process, e.ElapsedNS = r.process, time.Since(r.start).Nanoseconds()
	return r.locked(func(f *os.File) error { return json.NewEncoder(f).Encode(e) })
}

// 每次只读取上次检查后新增的原始条目，在跨进程锁内合并历史偏移。
func (r *recorder) history() error {
	return r.locked(func(log *os.File) error {
		if _, err := log.Seek(r.cursor, io.SeekStart); err != nil {
			return err
		}
		d := json.NewDecoder(log)
		for {
			var e RawEntry
			if err := d.Decode(&e); err != nil {
				if err == io.EOF {
					break
				}
				return err
			}
			if e.Type == "native_history" {
				r.offsets[e.Path] += int64(len(e.Data))
			}
		}
		for _, dir := range r.dirs {
			err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
				if os.IsNotExist(err) {
					return nil
				}
				if err != nil {
					return err
				}
				// 只读普通文件，不沿符号链接读取目录外的文件。
				if !entry.Type().IsRegular() {
					return nil
				}
				f, err := os.Open(path)
				if err != nil {
					return err
				}
				defer f.Close()
				if _, err = f.Seek(r.offsets[path], io.SeekStart); err != nil {
					return err
				}
				data, err := io.ReadAll(f)
				if err != nil {
					return err
				}
				end := bytes.LastIndexByte(data, '\n') + 1
				if end == 0 {
					return nil
				}
				e := RawEntry{Type: "native_history", Process: r.process, ElapsedNS: time.Since(r.start).Nanoseconds(), Path: path, Data: data[:end]}
				if err := json.NewEncoder(log).Encode(e); err != nil {
					return err
				}
				r.offsets[path] += int64(end)
				return nil
			})
			if err != nil {
				return err
			}
		}
		var err error
		r.cursor, err = log.Seek(0, io.SeekEnd)
		return err
	})
}

type recordStream struct {
	r       *recorder
	kind    string
	dst     io.Writer
	pending []byte
}

func (s *recordStream) Write(p []byte) (int, error) {
	s.r.mu.Lock()
	s.pending = append(s.pending, p...)
	var err error
	for {
		i := bytes.IndexByte(s.pending, '\n')
		if i < 0 {
			break
		}
		if s.kind == "stdout" {
			err = s.r.history()
		}
		if err == nil {
			err = s.r.append(RawEntry{Type: s.kind, Data: s.pending[:i+1]})
		}
		if err != nil {
			break
		}
		s.pending = s.pending[i+1:]
	}
	s.r.mu.Unlock()
	if err != nil {
		return 0, err
	}
	// 部分帧也立即透传，LF 只控制原始录制条目的边界。
	return s.dst.Write(p)
}

func (s *recordStream) flush() error {
	s.r.mu.Lock()
	defer s.r.mu.Unlock()
	if len(s.pending) == 0 {
		return nil
	}
	if s.kind == "stdout" {
		if err := s.r.history(); err != nil {
			return err
		}
	}
	err := s.r.append(RawEntry{Type: s.kind, Data: s.pending})
	s.pending = nil
	return err
}

var scenarioName = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// Record 消耗并关闭 stdin；调用方应提供可被 Close 中断的读取器。
func Record(ctx context.Context, c RecordConfig, args []string, stdin io.ReadCloser, stdout, stderr io.Writer) (Exit, error) {
	if err := temporaryRawDir(c.RawDir); err != nil {
		return Exit{Code: 1}, err
	}
	scenario, err := os.ReadFile(c.ScenarioFile)
	if err != nil {
		return Exit{Code: 1}, err
	}
	var h Header
	if err := json.Unmarshal(scenario, &h); err != nil {
		return Exit{Code: 1}, err
	}
	if !scenarioName.MatchString(h.Scenario) {
		return Exit{Code: 1}, errors.New("scenario 只能包含字母、数字、下划线和连字符")
	}
	host, err := os.Hostname()
	if err != nil {
		return Exit{Code: 1}, err
	}
	u, err := user.Current()
	if err != nil {
		return Exit{Code: 1}, err
	}
	header := RawHeader{Type: "raw_start", Version: 1, Transcript: h, Bindings: c.Bindings, Hostname: host, Username: u.Username}
	r := &recorder{path: filepath.Join(c.RawDir, h.Scenario+".raw.ndjson"), start: time.Now(), offsets: map[string]int64{}, dirs: append([]string(nil), c.HistoryDirs...)}
	if dir := argument(args, "--session-dir"); dir != "" {
		r.dirs = append(r.dirs, dir)
	}
	err = r.locked(func(f *os.File) error {
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if info.Size() == 0 {
			if err := json.NewEncoder(f).Encode(header); err != nil {
				return err
			}
			r.process = 1
		} else {
			raw, err := ReadRaw(f)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(raw.Header, header) {
				return errors.New("同一场景的原始录制头部不一致")
			}
			for _, e := range raw.Entries {
				if e.Type == "process_start" {
					r.process++
				}
				if e.Type == "native_history" {
					r.offsets[e.Path] += int64(len(e.Data))
				}
			}
			r.process++
		}
		if err := json.NewEncoder(f).Encode(RawEntry{Type: "process_start", Process: r.process, ElapsedNS: time.Since(r.start).Nanoseconds(), Args: args}); err != nil {
			return err
		}
		r.cursor, err = f.Seek(0, io.SeekEnd)
		return err
	})
	if err != nil {
		return Exit{Code: 1}, err
	}
	cmd := exec.CommandContext(ctx, c.AgentBinary, args...)
	input, err := cmd.StdinPipe()
	if err != nil {
		return Exit{Code: 1}, err
	}
	in := &recordStream{r: r, kind: "stdin", dst: input}
	out := &recordStream{r: r, kind: "stdout", dst: stdout}
	diagnostic := &recordStream{r: r, kind: "stderr", dst: stderr}
	outputPipe, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return Exit{Code: 1}, err
	}
	errorPipe, err := cmd.StderrPipe()
	if err != nil {
		input.Close()
		outputPipe.Close()
		return Exit{Code: 1}, err
	}
	if err := cmd.Start(); err != nil {
		input.Close()
		outputPipe.Close()
		errorPipe.Close()
		return Exit{Code: 1}, err
	}
	copyOutput := func(stream *recordStream, source io.ReadCloser) <-chan error {
		done := make(chan error, 1)
		go func() { _, err := io.Copy(stream, source); done <- errors.Join(err, stream.flush(), source.Close()) }()
		return done
	}
	outputDone := copyOutput(out, outputPipe)
	errorDone := copyOutput(diagnostic, errorPipe)
	stopSignals := forwardRecordSignals(cmd.Process)
	defer stopSignals()
	inputDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(in, stdin)
		// 子进程退出后关闭读取器，只忽略清理产生的关闭错误。
		if errors.Is(copyErr, os.ErrClosed) || errors.Is(copyErr, io.ErrClosedPipe) {
			copyErr = nil
		}
		flushErr := in.flush()
		closeErr := input.Close()
		if errors.Is(closeErr, os.ErrClosed) {
			closeErr = nil
		}
		inputDone <- errors.Join(copyErr, flushErr, closeErr)
	}()
	outputErr, diagnosticErr := <-outputDone, <-errorDone
	waitErr := cmd.Wait()
	_ = stdin.Close()
	inputErr := <-inputDone
	exit := recordExit(cmd.ProcessState)
	r.mu.Lock()
	writeErr := r.append(RawEntry{Type: "runtime_exit", Code: exit.Code, Signal: exit.Signal})
	r.mu.Unlock()
	var processErr *exec.ExitError
	if errors.As(waitErr, &processErr) {
		waitErr = nil
	}
	return exit, errors.Join(inputErr, outputErr, diagnosticErr, writeErr, waitErr)
}

func argument(args []string, name string) string {
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}
