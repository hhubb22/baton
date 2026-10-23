package main

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"runtime"
	"testing"

	"baton/internal/node"
)

func TestUpAndRunDefaultHome(t *testing.T) {
	home := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	} else {
		t.Setenv("HOME", home)
	}
	realHome, _ := filepath.EvalSymlinks(home)
	for _, command := range []string{"up", "run"} {
		t.Run(command, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "node")
			ident := cliIdentity(t)
			ident.CoordinatorURL = "https://baton.example"
			if err := node.WriteIdentity(dir, ident); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			err := runWithOptions(ctx, []string{command, "--data-dir", dir}, io.Discard, io.Discard, nil, node.RunOptions{
				ProbeRuntimeAgentVersion: func(context.Context, string) (string, error) { return "", errors.New("未启用版本探测") },
			})
			if err != nil {
				t.Fatal(err)
			}
			roots, err := node.ListBrowseRoots(dir)
			if err != nil || len(roots) != 1 || roots[0].Path != realHome {
				t.Fatalf("启动未登记主目录: %+v %v", roots, err)
			}
		})
	}
}
