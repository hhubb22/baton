package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"baton/internal/node"
	"baton/internal/redact"
	"baton/internal/relay"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stderr, os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, redact.Scrub(err.Error()))
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stderr io.Writer, getenv func(string) string) error {
	if len(args) != 0 {
		return errors.New("用法: relay")
	}
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	opts := relay.Options{
		ListenAddr:     strings.TrimSpace(getenv("BATON_LISTEN_ADDR")),
		CoordinatorURL: strings.TrimSpace(getenv("BATON_COORDINATOR_URL")),
		ControlToken:   strings.TrimSpace(getenv("BATON_CONTROL_TOKEN")),
		CertFile:       strings.TrimSpace(getenv("BATON_TLS_CERT_FILE")),
		KeyFile:        strings.TrimSpace(getenv("BATON_TLS_KEY_FILE")),
		Logger:         slog.New(slog.NewTextHandler(stderr, nil)),
	}
	if opts.ListenAddr == "" || opts.CoordinatorURL == "" || opts.CertFile == "" || opts.KeyFile == "" {
		return errors.New("需要设置 BATON_LISTEN_ADDR、BATON_COORDINATOR_URL、BATON_TLS_CERT_FILE 和 BATON_TLS_KEY_FILE")
	}
	if len(opts.ControlToken) < 20 || len(opts.ControlToken) > 200 {
		return errors.New("BATON_CONTROL_TOKEN 无效")
	}
	roots, err := node.LoadRootCAs(strings.TrimSpace(getenv("BATON_TLS_CA_FILE")))
	if err != nil {
		return err
	}
	opts.RootCAs = roots
	server, err := relay.New(opts)
	if err != nil {
		return err
	}
	return server.Run(ctx)
}
