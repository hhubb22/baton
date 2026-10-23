package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"baton/internal/node"
	"baton/internal/projectruntime"
	"baton/internal/redact"
	"baton/internal/session"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr, os.Getenv); err != nil {
		var coded *exitCode
		if errors.As(err, &coded) {
			fmt.Fprintln(os.Stderr, redact.Scrub(coded.Error()))
			os.Exit(coded.code)
		}
		fmt.Fprintln(os.Stderr, redact.Scrub(err.Error()))
		os.Exit(1)
	}
}

type exitCode struct {
	code int
	err  error
}

func (e *exitCode) Error() string { return e.err.Error() }
func (e *exitCode) Unwrap() error { return e.err }

func usage() string {
	return `用法:
  batond register --coordinator https://主机 --display-name 名称 --system windows|macos|linux [--data-dir 目录] [--capability 名称 ...] [--enrollment-file 文件]
  batond run --relay wss://主机/v1/node [--data-dir 目录]
  batond files add --id 标识 --path 绝对路径 [--data-dir 目录]
  batond files remove --id 标识 [--data-dir 目录]
  batond files list [--data-dir 目录]
  batond project-exec --enabled=true|false [--shell 路径] [--data-dir 目录]
  batond login openai-codex|xai
  batond subscriptions

注册凭据从环境变量 BATON_ENROLLMENT_TOKEN 或 --enrollment-file 读取，不能作为命令行参数，也不能放进地址。
可选环境变量 BATON_TLS_CA_FILE 指向额外的 CA 证书。
未指定 --data-dir 时使用当前用户的应用数据目录。
batond run 使用已保存的身份连接 Coordinator。BATON_HEARTBEAT_INTERVAL 默认 10s，允许 100ms 到 2m。
认证失效时退出并说明需要重新认证，不会重新注册。
batond files 只在本机登记可浏览目录。浏览器提交目录标识和相对路径，不能提交绝对路径。
batond login 登录 Project assistant 的模型订阅：openai-codex 对应 ChatGPT，xai 对应 xAI。
batond subscriptions 查看本机订阅登录状态，不刷新 token 或请求模型。
订阅凭据默认保存在 ~/.baton/project-runtime，可用 BATON_PROJECT_RUNTIME_DATA_DIR 指定目录；请与 batond run 使用相同的系统用户和配置。
`
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) error {
	return runWithOptions(ctx, args, stdout, stderr, getenv, node.RunOptions{})
}

func runWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string, opts node.RunOptions) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	switch args[0] {
	case "register":
		return cmdRegister(ctx, args[1:], stdout, stderr, getenv)
	case "run":
		return cmdRun(ctx, args[1:], stderr, getenv, opts)
	case "files":
		return cmdFiles(args[1:], stdout, getenv)
	case "project-exec":
		return cmdProjectExec(args[1:], stdout, getenv)
	case "login":
		return cmdLogin(ctx, args[1:], os.Stdin, stdout, stderr, projectruntime.Command)
	case "subscriptions":
		return cmdSubscriptions(ctx, args[1:], stdout, projectruntime.Probe)
	case "sidecar-file":
		return cmdSidecarFile(args[1:], stdout)
	case "worker":
		return cmdWorker(ctx, args[1:])
	default:
		return &exitCode{code: 2, err: errors.New(usage())}
	}
}

func cmdRun(ctx context.Context, args []string, stderr io.Writer, getenv func(string) string, opts node.RunOptions) error {
	relayURL, dataDir, err := parseRun(args)
	if err != nil {
		return err
	}
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	dir := dataDir
	if dir == "" {
		dir, err = node.DefaultDataDir(getenv)
		if err != nil {
			return err
		}
	}
	ident, err := node.ReadIdentity(dir)
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("本地没有节点身份")
	}
	if err != nil {
		return err
	}
	heartbeat, err := heartbeatInterval(getenv("BATON_HEARTBEAT_INTERVAL"))
	if err != nil {
		return err
	}
	roots, err := node.LoadRootCAs(strings.TrimSpace(getenv("BATON_TLS_CA_FILE")))
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewTextHandler(stderr, nil))
	opts.RelayURL = relayURL
	opts.Identity = ident
	opts.Heartbeat = heartbeat
	opts.RootCAs = roots
	opts.Logger = logger
	opts.DataDir = dir
	err = node.Maintain(ctx, opts)
	if errors.Is(err, node.ErrNeedsReauth) {
		return err
	}
	return err
}

func cmdWorker(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("worker", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var dataDir, sessionID string
	fs.StringVar(&dataDir, "data-dir", "", "")
	fs.StringVar(&sessionID, "session", "", "")
	if err := fs.Parse(args); err != nil || strings.TrimSpace(dataDir) == "" || strings.TrimSpace(sessionID) == "" {
		return &exitCode{code: 2, err: errors.New("batond worker 是内部子命令")}
	}
	if err := session.RunWorker(ctx, dataDir, sessionID); err != nil {
		return &exitCode{code: 1, err: err}
	}
	return nil
}

func parseRun(args []string) (string, string, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var relayURL, dataDir string
	fs.StringVar(&relayURL, "relay", "", "")
	fs.StringVar(&dataDir, "data-dir", "", "")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || strings.TrimSpace(relayURL) == "" {
		return "", "", &exitCode{code: 2, err: errors.New(usage())}
	}
	return relayURL, dataDir, nil
}

func heartbeatInterval(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 10 * time.Second, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 100*time.Millisecond || d > 2*time.Minute {
		return 0, errors.New("BATON_HEARTBEAT_INTERVAL 无效")
	}
	return d, nil
}

type registerOpts struct {
	coordinator  string
	dataDir      string
	displayName  string
	system       string
	role         string
	enrollment   string
	capabilities []string
}

func cmdRegister(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) error {
	opts, err := parseRegister(args)
	if err != nil {
		return err
	}
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	dir := opts.dataDir
	if dir == "" {
		dir, err = node.DefaultDataDir(getenv)
		if err != nil {
			return err
		}
	}
	if err := node.PrepareDataDir(dir); err != nil {
		return err
	}
	existing, err := node.ReadIdentity(dir)
	if err == nil {
		if _, err := io.WriteString(stdout, node.FormatPublic(existing)); err != nil {
			return err
		}
		_, err = fmt.Fprintln(stderr, "本地已有节点身份，未重新注册")
		return err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	token, err := enrollmentToken(opts.enrollment, getenv)
	if err != nil {
		return err
	}
	ident, err := node.Register(ctx, node.RegisterRequest{
		CoordinatorURL:  opts.coordinator,
		CAFile:          strings.TrimSpace(getenv("BATON_TLS_CA_FILE")),
		EnrollmentToken: token,
		DisplayName:     opts.displayName,
		System:          opts.system,
		Role:            opts.role,
		Capabilities:    opts.capabilities,
	})
	if err != nil {
		return err
	}
	if err := node.WriteIdentity(dir, ident); err != nil {
		return fmt.Errorf("中心已注册节点 %s，但本地身份保存失败", ident.NodeID)
	}
	if _, err := io.WriteString(stdout, node.FormatPublic(ident)); err != nil {
		return err
	}
	_, err = fmt.Fprintln(stderr, node.FileFallbackNotice)
	return err
}

func parseRegister(args []string) (registerOpts, error) {
	fs := flag.NewFlagSet("register", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var opts registerOpts
	var caps stringList
	fs.StringVar(&opts.coordinator, "coordinator", "", "")
	fs.StringVar(&opts.dataDir, "data-dir", "", "")
	fs.StringVar(&opts.displayName, "display-name", "", "")
	fs.StringVar(&opts.system, "system", "", "")
	fs.StringVar(&opts.role, "role", "", "")
	fs.StringVar(&opts.enrollment, "enrollment-file", "", "")
	fs.Var(&caps, "capability", "")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return registerOpts{}, &exitCode{code: 2, err: errors.New(usage())}
	}
	if opts.coordinator == "" || opts.displayName == "" || opts.system == "" {
		return registerOpts{}, &exitCode{code: 2, err: errors.New(usage())}
	}
	opts.capabilities = []string(caps)
	return opts, nil
}

func enrollmentToken(path string, getenv func(string) string) (string, error) {
	envToken := strings.TrimSpace(getenv("BATON_ENROLLMENT_TOKEN"))
	path = strings.TrimSpace(path)
	if path != "" && envToken != "" {
		return "", errors.New("只能用一种方式提供注册凭据")
	}
	if path != "" {
		return node.ReadSecretFile(path)
	}
	if envToken == "" {
		return "", errors.New("需要通过环境变量 BATON_ENROLLMENT_TOKEN 或 --enrollment-file 提供注册凭据")
	}
	if !node.ValidSecret(envToken) {
		return "", errors.New("注册凭据无效")
	}
	return envToken, nil
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}
