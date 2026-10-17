package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"baton/internal/node"
	"baton/internal/redact"
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
  batond register --coordinator https://主机 --display-name 名称 --system windows|macos|linux --role pc|ubuntu [--data-dir 目录] [--capability 名称 ...] [--enrollment-file 文件]

注册凭据从环境变量 BATON_ENROLLMENT_TOKEN 或 --enrollment-file 读取，不能作为命令行参数，也不能放进地址。
可选环境变量 BATON_TLS_CA_FILE 指向额外的 CA 证书。
未指定 --data-dir 时使用当前用户的应用数据目录。
`
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	if args[0] != "register" {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	return cmdRegister(ctx, args[1:], stdout, stderr, getenv)
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
	if opts.coordinator == "" || opts.displayName == "" || opts.system == "" || opts.role == "" {
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
