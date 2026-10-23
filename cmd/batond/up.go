package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"path/filepath"

	"baton/internal/node"
)

func cmdUp(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string, runOpts node.RunOptions) error {
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	opts := registerFlags(fs)
	var workspace, relay string
	fs.StringVar(&workspace, "workspace", "", "")
	fs.StringVar(&relay, "relay", "", "")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	if workspace != "" && !filepath.IsAbs(workspace) {
		return errors.New("--workspace 需要是绝对路径")
	}
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	if opts.dataDir == "" {
		var err error
		opts.dataDir, err = node.DefaultDataDir(getenv)
		if err != nil {
			return err
		}
	}
	if err := register(ctx, *opts, stdout, stderr, getenv); err != nil {
		return err
	}
	if workspace != "" {
		if err := ensureWorkspace(opts.dataDir, workspace); err != nil {
			return err
		}
	}
	node.EnsureDefaultBrowseRoot(opts.dataDir)
	return cmdRun(ctx, []string{"--data-dir", opts.dataDir, "--relay", relay}, stderr, getenv, runOpts)
}

func ensureWorkspace(dataDir, workspace string) error {
	_, err := node.AddBrowseRootPath(dataDir, workspace)
	return err
}
