package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/config"
	"baton/internal/control"
	"baton/internal/db"
	"baton/internal/gateway"
	"baton/internal/httpapi"
	"baton/internal/migrate"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/redact"
	"baton/internal/store"
	"baton/internal/webui"

	"github.com/jackc/pgx/v5/pgxpool"
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
  coordinator migrate
  coordinator serve
  coordinator admin employee create --username <用户名> --display-name <显示名>
  coordinator admin employee reset-password --username <用户名>
`
}

// RunOptions 提供 Coordinator 的运行依赖。
type RunOptions struct {
	ProjectAgentLeaseDuration time.Duration
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) error {
	return runWithOptions(ctx, args, stdout, stderr, getenv, RunOptions{})
}

func runWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string, opts RunOptions) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	switch args[0] {
	case "migrate":
		if len(args) != 1 {
			return &exitCode{code: 2, err: errors.New(usage())}
		}
		return withDB(ctx, getenv, false, func(_ config.Config, pool *pgxpool.Pool) error {
			return migrate.Up(ctx, pool)
		})
	case "serve":
		if len(args) != 1 {
			return &exitCode{code: 2, err: errors.New(usage())}
		}
		return cmdServe(ctx, stderr, getenv, opts)
	case "admin":
		return cmdAdmin(ctx, args[1:], stdout, stderr, getenv)
	default:
		return &exitCode{code: 2, err: errors.New(usage())}
	}
}

func cmdAdmin(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) error {
	if len(args) < 2 || args[0] != "employee" {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	switch args[1] {
	case "create":
		return withDB(ctx, getenv, false, func(_ config.Config, pool *pgxpool.Pool) error {
			return cmdCreate(ctx, args[2:], stdout, stderr, pool)
		})
	case "reset-password":
		return withDB(ctx, getenv, false, func(_ config.Config, pool *pgxpool.Pool) error {
			return cmdReset(ctx, args[2:], stdout, stderr, pool)
		})
	default:
		return &exitCode{code: 2, err: errors.New(usage())}
	}
}

func cmdCreate(ctx context.Context, args []string, stdout, stderr io.Writer, pool *pgxpool.Pool) error {
	username, displayName, err := parseCreate(args)
	if err != nil {
		return err
	}
	password, err := auth.GeneratePassword()
	if err != nil {
		return err
	}
	emp, err := admin.CreateLocal(ctx, pool, username, displayName, password)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(stdout, admin.FormatIssuedPassword(emp.Username, password)); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stderr, "已创建本地账号 %s\n", emp.Username)
	return err
}

func parseCreate(args []string) (string, string, error) {
	fs := flag.NewFlagSet("create", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	displayName := fs.String("display-name", "", "")
	if err := fs.Parse(args); err != nil || *username == "" || *displayName == "" || fs.NArg() != 0 {
		return "", "", &exitCode{code: 2, err: errors.New(usage())}
	}
	return *username, *displayName, nil
}

func cmdReset(ctx context.Context, args []string, stdout, stderr io.Writer, pool *pgxpool.Pool) error {
	fs := flag.NewFlagSet("reset-password", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	username := fs.String("username", "", "")
	if err := fs.Parse(args); err != nil || *username == "" || fs.NArg() != 0 {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	password, emp, err := admin.ResetPassword(ctx, pool, *username)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(stdout, admin.FormatIssuedPassword(emp.Username, password)); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stderr, "已重置本地账号 %s 的口令\n", emp.Username)
	return err
}

func cmdServe(ctx context.Context, stderr io.Writer, getenv func(string) string, opts RunOptions) error {
	return withDB(ctx, getenv, true, func(cfg config.Config, pool *pgxpool.Pool) error {
		if err := migrate.Check(ctx, pool); err != nil {
			return err
		}
		if cfg.TLS() {
			if _, statErr := os.Stat(cfg.TLSCertFile); statErr != nil {
				return errors.New("无法读取 TLS 证书文件")
			}
			if _, statErr := os.Stat(cfg.TLSKeyFile); statErr != nil {
				return errors.New("无法读取 TLS 密钥文件")
			}
		}
		signer, err := node.LoadSigner(cfg.SigningKeyFile)
		if err != nil {
			return err
		}
		logger := slog.New(slog.NewTextHandler(stderr, nil))
		repo := store.NewWithOptions(pool, store.Options{ProjectAgentLeaseDuration: opts.ProjectAgentLeaseDuration})
		if err := repo.ResetConnections(ctx); err != nil {
			return err
		}
		outputBudget := protocol.NewBudget(protocol.MaxOutputCacheBytes)
		ctrl, err := control.New(repo, signer, logger, outputBudget)
		if err != nil {
			return err
		}
		gw := gateway.New(ctrl, ctrl, cfg.OfflineAfter, logger, outputBudget)
		ctrl.SetSender(gw)
		defer gw.Close()
		if err := ctrl.DispatchRevocations(ctx); err != nil {
			return err
		}
		api, err := httpapi.New(pool, httpapi.Settings{
			OutputBudget:      outputBudget,
			Origins:           cfg.AllowedOrigins,
			SessionTTL:        cfg.SessionTTL,
			EnrollmentTTL:     cfg.EnrollmentTTL,
			NodeCredentialTTL: cfg.NodeCredentialTTL,
			Signer:            signer,
			Revocations:       ctrl,
			Files:             ctrl,
			Sessions:          ctrl,
			ProjectPreviews:   ctrl,
			Logger:            logger,
		})
		if err != nil {
			return err
		}
		mux := http.NewServeMux()
		mux.Handle("/", api)
		mux.Handle(protocol.NodePath, gw)
		apiSrv := &http.Server{
			Handler:           longConnections(webui.Handler(mux)),
			ReadTimeout:       20 * time.Second,
			WriteTimeout:      60 * time.Second,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    1 << 16,
			ErrorLog:          log.New(scrubWriter{stderr}, "", 0),
		}
		apiLn, err := net.Listen("tcp", cfg.HTTPAddr)
		if err != nil {
			return fmt.Errorf("监听失败: %s", redact.Scrub(err.Error()))
		}
		errCh := make(chan error, 1)
		go func() {
			logger.Info("event=listening", "kind", "http", "addr", apiLn.Addr().String())
			if cfg.TLS() {
				errCh <- apiSrv.ServeTLS(apiLn, cfg.TLSCertFile, cfg.TLSKeyFile)
				return
			}
			errCh <- apiSrv.Serve(apiLn)
		}()
		loopCtx, cancelLoops := context.WithCancel(ctx)
		var loops sync.WaitGroup
		for _, runLoop := range []func(context.Context){gw.Run, ctrl.DeliverMaintenance, ctrl.DeliverThreads, ctrl.ScheduleProjectRunsLoop, ctrl.DeliverProjectRuns} {
			loops.Add(1)
			go func() {
				defer loops.Done()
				runLoop(loopCtx)
			}()
		}
		defer func() {
			cancelLoops()
			loops.Wait()
		}()
		shutdown := func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = apiSrv.Shutdown(shutdownCtx)
			gw.Close()
		}
		select {
		case <-ctx.Done():
			shutdown()
			return nil
		case err := <-errCh:
			shutdown()
			if err == nil || errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return fmt.Errorf("服务退出: %s", redact.Scrub(err.Error()))
		}
	})
}

func withDB(ctx context.Context, getenv func(string) string, serve bool, fn func(config.Config, *pgxpool.Pool) error) error {
	cfg, err := config.Load(getenv, serve)
	if err != nil {
		return err
	}
	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.Schema)
	if err != nil {
		return err
	}
	defer pool.Close()
	return fn(cfg, pool)
}

type scrubWriter struct {
	w io.Writer
}

func (s scrubWriter) Write(p []byte) (int, error) {
	_, err := io.WriteString(s.w, redact.Scrub(string(p)))
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// longConnections 清除长连接路由的请求期限，普通 API 继续使用服务器超时。
func longConnections(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == protocol.NodePath || r.URL.Path == "/api/v1/events" {
			rc := http.NewResponseController(w)
			_ = rc.SetReadDeadline(time.Time{})
			_ = rc.SetWriteDeadline(time.Time{})
		}
		next.ServeHTTP(w, r)
	})
}
