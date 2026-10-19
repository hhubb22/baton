package fileaccess

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"baton/internal/protocol"
)

const (
	RuntimeScanDepth   = 4
	RuntimeScanEntries = 4096
	RuntimeScanRepos   = 128
	runtimeConfigBytes = 16 << 10
)

// ScanRuntimeRoots 只采集登记路径和 Git 元数据。目录句柄把遍历及元数据读取限制在登记根内。
func ScanRuntimeRoots(ctx context.Context, dir string) ([]protocol.RuntimeRoot, []protocol.RuntimeRepo, bool) {
	roots := []protocol.RuntimeRoot{}
	repos := []protocol.RuntimeRepo{}
	registered, err := ListBrowseRoots(dir)
	if err != nil {
		return roots, repos, true
	}
	left, truncated := RuntimeScanEntries, false
	seen := map[string]bool{}
	for _, entry := range registered {
		if ctx.Err() != nil {
			truncated = true
			break
		}
		root, err := openConfiguredRoot(entry.Path)
		if err != nil {
			truncated = true
			continue
		}
		real, err := filepath.EvalSymlinks(entry.Path)
		if err != nil {
			root.Close()
			truncated = true
			continue
		}
		// 真实路径与已打开的目录必须仍然指向同一对象。
		before, e1 := root.Stat(".")
		after, e2 := os.Stat(real)
		if e1 != nil || e2 != nil || !os.SameFile(before, after) {
			root.Close()
			truncated = true
			continue
		}
		roots = append(roots, protocol.RuntimeRoot{RootID: entry.ID, Path: real})
		var walk func(string, int)
		walk = func(rel string, depth int) {
			if ctx.Err() != nil || left <= 0 || len(repos) >= RuntimeScanRepos {
				truncated = true
				return
			}
			gitPath := filepath.Join(rel, ".git")
			if info, err := root.Lstat(gitPath); err == nil && (info.IsDir() || info.Mode().IsRegular()) {
				path := filepath.Join(real, rel)
				if !seen[path] {
					seen[path] = true
					origin, incomplete := runtimeOrigin(ctx, root, real, gitPath, info.IsDir())
					truncated = truncated || incomplete
					repos = append(repos, protocol.RuntimeRepo{Path: path, Origin: origin})
				}
			}
			if depth == RuntimeScanDepth {
				truncated = true
				return
			}
			f, err := openInRoot(root, rel)
			if err != nil {
				truncated = true
				return
			}
			defer f.Close()
			info, err := f.Stat()
			if err != nil || !info.IsDir() {
				return
			}
			// 每次仅保存一小批条目，超大目录不会先整体读入内存。
			for left > 0 && ctx.Err() == nil && len(repos) < RuntimeScanRepos {
				n := min(64, left)
				entries, err := f.ReadDir(n)
				left -= len(entries)
				for _, child := range entries {
					if child.Name() == ".git" || child.Type()&os.ModeSymlink != 0 || !child.IsDir() || !allowedEntryName(child.Name()) {
						continue
					}
					walk(filepath.Join(rel, child.Name()), depth+1)
				}
				if err == io.EOF {
					return
				}
				if err != nil {
					truncated = true
					return
				}
			}
			truncated = true
		}
		walk(".", 0)
		root.Close()
	}
	sort.Slice(repos, func(i, j int) bool { return repos[i].Path < repos[j].Path })
	return roots, repos, truncated
}

func runtimeMetadata(root *os.Root, path string, max int) ([]byte, bool) {
	info, err := root.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > int64(max) {
		return nil, false
	}
	f, err := openInRoot(root, path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	current, err := f.Stat()
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(info, current) {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(max)+1))
	return raw, err == nil && len(raw) <= max
}

func runtimeOrigin(ctx context.Context, root *os.Root, real, gitPath string, directory bool) (string, bool) {
	if !directory {
		raw, ok := runtimeMetadata(root, gitPath, 4096)
		if !ok || !strings.HasPrefix(string(raw), "gitdir: ") {
			return "", true
		}
		gitPath = runtimeGitPath(real, filepath.Dir(gitPath), strings.TrimSpace(strings.TrimPrefix(string(raw), "gitdir: ")))
		if gitPath == "" {
			return "", true
		}
	}
	commonPath := filepath.Join(gitPath, "commondir")
	if _, err := root.Lstat(commonPath); !errors.Is(err, os.ErrNotExist) {
		common, ok := runtimeMetadata(root, commonPath, 4096)
		if err != nil || !ok {
			return "", true
		}
		gitPath = runtimeGitPath(real, gitPath, strings.TrimSpace(string(common)))
		if gitPath == "" {
			return "", true
		}
	}
	raw, ok := runtimeMetadata(root, filepath.Join(gitPath, "config"), runtimeConfigBytes)
	if !ok || ctx.Err() != nil {
		return "", true
	}
	callCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	// 只解析有界的本地配置；不读取 include、全局配置，也不访问远端。
	cmd := exec.CommandContext(callCtx, "git", "config", "--no-includes", "--file", "-", "--get", "remote.origin.url")
	cmd.Stdin = bytes.NewReader(raw)
	cmd.WaitDelay = 100 * time.Millisecond
	var out runtimeOutput
	cmd.Stdout = &out
	err := cmd.Run()
	if out.overflow {
		return "", true
	}
	if err != nil {
		var exit *exec.ExitError
		// Git 以退出码 1 表示配置中没有 origin，这仍是完整的采集结果。
		return "", !(errors.As(err, &exit) && exit.ExitCode() == 1)
	}
	return protocol.SanitizeOrigin(strings.TrimSpace(out.String())), false
}

func runtimeGitPath(real, base, target string) string {
	if filepath.IsAbs(target) {
		var err error
		target, err = filepath.EvalSymlinks(target)
		if err != nil {
			return ""
		}
		target, err = filepath.Rel(real, target)
		if err != nil {
			return ""
		}
	} else {
		target = filepath.Join(base, target)
	}
	if !filepath.IsLocal(target) {
		return ""
	}
	return target
}

type runtimeOutput struct {
	buffer   bytes.Buffer
	overflow bool
}

func (b *runtimeOutput) Len() int       { return b.buffer.Len() }
func (b *runtimeOutput) String() string { return b.buffer.String() }

func (b *runtimeOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+n > runtimeConfigBytes {
		b.overflow = true
	}
	b.buffer.Write(p[:min(n, runtimeConfigBytes-b.Len())])
	return n, nil
}
