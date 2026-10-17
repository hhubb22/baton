package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"baton/internal/node"
)

func cmdFiles(args []string, stdout io.Writer, getenv func(string) string) error {
	if len(args) == 0 {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	action := args[0]
	fs := flag.NewFlagSet("files", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var dataDir, id, rootPath string
	fs.StringVar(&dataDir, "data-dir", "", "")
	fs.StringVar(&id, "id", "", "")
	fs.StringVar(&rootPath, "path", "", "")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		return &exitCode{code: 2, err: errors.New(usage())}
	}
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	var err error
	if strings.TrimSpace(dataDir) == "" {
		dataDir, err = node.DefaultDataDir(getenv)
		if err != nil {
			return err
		}
	}
	switch action {
	case "add":
		if strings.TrimSpace(id) == "" || strings.TrimSpace(rootPath) == "" {
			return &exitCode{code: 2, err: errors.New(usage())}
		}
		if err := node.AddBrowseRoot(dataDir, id, rootPath); err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "已登记浏览目录 %s\n", id)
		return err
	case "remove":
		if strings.TrimSpace(id) == "" || strings.TrimSpace(rootPath) != "" {
			return &exitCode{code: 2, err: errors.New(usage())}
		}
		if err := node.RemoveBrowseRoot(dataDir, id); err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "已移除浏览目录 %s\n", id)
		return err
	case "list":
		if strings.TrimSpace(id) != "" || strings.TrimSpace(rootPath) != "" {
			return &exitCode{code: 2, err: errors.New(usage())}
		}
		roots, err := node.ListBrowseRoots(dataDir)
		if err != nil {
			return err
		}
		if len(roots) == 0 {
			_, err = fmt.Fprintln(stdout, "还没有浏览目录")
			return err
		}
		for _, root := range roots {
			if _, err := fmt.Fprintf(stdout, "%s\t%s\n", root.ID, root.Path); err != nil {
				return err
			}
		}
		return nil
	default:
		return &exitCode{code: 2, err: errors.New(usage())}
	}
}
