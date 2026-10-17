// Package node 负责节点注册字段、本地身份和向 Coordinator 注册。
package node

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"baton/internal/identity"
)

const (
	IdentityFileName = "identity.json"

	// FileFallbackNotice 说明身份秘密写在本地文件，而不是系统凭据存储。
	FileFallbackNotice = "节点身份保存在本地文件，未使用系统凭据存储"
)

// ErrIdentityExists 表示数据目录里已经有节点身份，不能覆盖。
var ErrIdentityExists = errors.New("identity exists")

// Credential 是发给节点的连接凭据。Token 只在签发和本地身份文件中出现。
type Credential struct {
	ID        string    `json:"id"`
	Version   int       `json:"version"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Identity 是注册成功后保存在节点本地的身份。重启后继续使用同一份。
type Identity struct {
	NodeID          string     `json:"node_id"`
	EmployeeID      string     `json:"employee_id"`
	DisplayName     string     `json:"display_name"`
	System          string     `json:"system"`
	Role            string     `json:"role"`
	Capabilities    []string   `json:"capabilities"`
	RegistrationSeq int64      `json:"registration_seq"`
	RegisteredAt    time.Time  `json:"registered_at"`
	Credential      Credential `json:"credential"`
}

// SavedDefault 是中心实际保存的默认 PC，字段来自数据库而不是请求正文。
type SavedDefault struct {
	NodeID          string `json:"default_pc_node_id"`
	DisplayName     string `json:"display_name"`
	System          string `json:"system"`
	Role            string `json:"role"`
	RegistrationSeq int64  `json:"registration_seq"`
}

// FormatPublic 写出可以给操作者看的身份摘要，不包含连接凭据。
func FormatPublic(id Identity) string {
	return fmt.Sprintf("node_id=%s\nemployee_id=%s\ndisplay_name=%s\nsystem=%s\nrole=%s\ncredential_id=%s\nregistration_seq=%d\n",
		id.NodeID, id.EmployeeID, id.DisplayName, id.System, id.Role, id.Credential.ID, id.RegistrationSeq)
}

func (id Identity) complete() error {
	if _, err := identity.ParseUUID(id.NodeID); err != nil {
		return err
	}
	if _, err := identity.ParseUUID(id.EmployeeID); err != nil {
		return err
	}
	if _, err := identity.ParseUUID(id.Credential.ID); err != nil {
		return err
	}
	if id.Credential.Token == "" || !ValidSecret(id.Credential.Token) || id.Credential.Version < 1 {
		return errors.New("incomplete credential")
	}
	if id.RegistrationSeq < 1 || id.RegisteredAt.IsZero() || id.Credential.ExpiresAt.IsZero() {
		return errors.New("incomplete identity")
	}
	caps := id.Capabilities
	if caps == nil {
		caps = []string{}
	}
	return Validate(id.DisplayName, id.System, id.Role, caps)
}

// PrepareDataDir 创建仅当前用户可进入的数据目录。
func PrepareDataDir(dir string) error {
	if strings.TrimSpace(dir) == "" || dir == "." {
		return errors.New("节点数据目录无效")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("无法创建节点数据目录")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return errors.New("无法限制节点数据目录的权限")
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return errors.New("无法读取节点数据目录")
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("节点数据目录无效")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return errors.New("节点数据目录允许其他用户进入")
	}
	return nil
}

// WriteIdentity 原子写入身份文件，并限制为仅当前用户可读写。
func WriteIdentity(dir string, ident Identity) error {
	if err := ident.complete(); err != nil {
		return errors.New("节点身份不完整")
	}
	if ident.Capabilities == nil {
		ident.Capabilities = []string{}
	}
	if err := PrepareDataDir(dir); err != nil {
		return err
	}
	body, err := json.MarshalIndent(ident, "", "  ")
	if err != nil {
		return errors.New("节点身份无法编码")
	}
	body = append(body, '\n')
	tmp, err := os.CreateTemp(dir, ".identity-*.tmp")
	if err != nil {
		return errors.New("无法写入节点身份")
	}
	tmpName := tmp.Name()
	written := false
	defer func() {
		if !written {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return errors.New("无法限制节点身份文件的权限")
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return errors.New("无法写入节点身份")
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return errors.New("无法写入节点身份")
	}
	if err := tmp.Close(); err != nil {
		return errors.New("无法写入节点身份")
	}
	dest := filepath.Join(dir, IdentityFileName)
	if _, err := os.Lstat(dest); err == nil {
		return ErrIdentityExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("无法写入节点身份")
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return errors.New("无法写入节点身份")
	}
	written = true
	if err := os.Chmod(dest, 0o600); err != nil {
		return errors.New("无法限制节点身份文件的权限")
	}
	if dirFile, err := os.Open(dir); err == nil {
		_ = dirFile.Sync()
		_ = dirFile.Close()
	}
	return nil
}

// ReadIdentity 读取本地身份。文件不存在时返回 os.ErrNotExist。
// 权限过宽、符号链接或内容损坏时返回其他错误，调用方不能据此重新注册。
func ReadIdentity(dir string) (Identity, error) {
	path := filepath.Join(dir, IdentityFileName)
	info, err := os.Lstat(path)
	if err != nil {
		return Identity{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return Identity{}, errors.New("节点身份文件无法读取")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return Identity{}, errors.New("节点身份文件允许其他用户读取")
	}
	dirInfo, err := os.Lstat(dir)
	if err != nil {
		return Identity{}, errors.New("节点身份文件无法读取")
	}
	if runtime.GOOS != "windows" && dirInfo.Mode().Perm()&0o077 != 0 {
		return Identity{}, errors.New("节点数据目录允许其他用户进入")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Identity{}, errors.New("节点身份文件无法读取")
	}
	var ident Identity
	if err := json.Unmarshal(raw, &ident); err != nil {
		return Identity{}, errors.New("节点身份文件无法读取")
	}
	if ident.Capabilities == nil {
		ident.Capabilities = []string{}
	}
	if err := ident.complete(); err != nil {
		return Identity{}, errors.New("节点身份文件无法读取")
	}
	return ident, nil
}

// ReadSecretFile 读取仅当前用户可读的注册凭据文件。错误文本不包含文件内容。
func ReadSecretFile(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", errors.New("无法读取注册凭据文件")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", errors.New("注册凭据文件无效")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("注册凭据文件允许其他用户读取")
	}
	if info.Size() == 0 || info.Size() > 512 {
		return "", errors.New("注册凭据文件无效")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("无法读取注册凭据文件")
	}
	token := strings.TrimSpace(string(raw))
	if !ValidSecret(token) {
		return "", errors.New("注册凭据文件无效")
	}
	return token, nil
}

// DefaultDataDir 返回当前系统约定的节点数据目录，不创建它。
func DefaultDataDir(getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return dataDir(runtime.GOOS, getenv, home)
}

func dataDir(goos string, getenv func(string) string, home string) (string, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	switch goos {
	case "darwin":
		if home == "" {
			return "", errors.New("无法确定用户主目录")
		}
		return filepath.Join(home, "Library", "Application Support", "baton", "node"), nil
	case "windows":
		base := strings.TrimSpace(getenv("LOCALAPPDATA"))
		if base == "" {
			return "", errors.New("无法确定 LocalAppData")
		}
		return filepath.Join(base, "baton", "node"), nil
	default:
		base := strings.TrimSpace(getenv("XDG_DATA_HOME"))
		if base == "" {
			if home == "" {
				return "", errors.New("无法确定用户主目录")
			}
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, "baton", "node"), nil
	}
}
