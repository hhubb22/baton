package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Manifest struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Entry    string `json:"entry"`
}

// Command 优先使用 batond 同目录的固定版本 bundle；独立安装通过 PATH 发现。
func Command(ctx context.Context, name, version, fallback string, args ...string) (*exec.Cmd, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return commandAt(ctx, filepath.Dir(executable), name, version, fallback, args...)
}
func commandAt(ctx context.Context, root, name, version, fallback string, args ...string) (*exec.Cmd, error) {
	dir := filepath.Join(root, "sidecars", name)
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if os.IsNotExist(err) {
		path, e := exec.LookPath(fallback)
		if e != nil {
			return nil, e
		}
		return exec.Command(path, args...), nil
	}
	if err != nil {
		return nil, err
	}
	var m Manifest
	if json.Unmarshal(raw, &m) != nil || m.Name != name || m.Version != version || m.Protocol != 1 || m.Entry == "" || filepath.IsAbs(m.Entry) || !filepath.IsLocal(m.Entry) {
		return nil, errors.New("sidecar 版本或 manifest 无效")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	out, err := Capture(ctx, exec.Command(node, "--version"), 128)
	if err != nil || !supportedNode(strings.TrimSpace(string(out))) {
		return nil, errors.New("sidecar 需要 Node.js >=22.19.0")
	}
	entry := filepath.Join(dir, m.Entry)
	resolved, err := filepath.EvalSymlinks(entry)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(dir, resolved)
	if err != nil || !filepath.IsLocal(rel) {
		return nil, errors.New("sidecar 入口越过 bundle 目录")
	}
	return exec.Command(node, append([]string{entry}, args...)...), nil
}
func supportedNode(version string) bool {
	var major, minor int
	parts := strings.Split(strings.TrimPrefix(version, "v"), ".")
	if len(parts) != 3 {
		return false
	}
	var err error
	major, err = strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	minor, err = strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	_, err = fmt.Sscanf(parts[2], "%d", new(int))
	return err == nil && (major > 22 || major == 22 && minor >= 19)
}
