package node

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	RolePC     = "pc"
	RoleUbuntu = "ubuntu"

	SystemWindows = "windows"
	SystemMacOS   = "macos"
	SystemLinux   = "linux"

	maxCapabilities = 32
)

var capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)

// ValidationError 是可以返回给调用方的节点字段错误，不包含凭据。
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string {
	if e == nil || e.Message == "" {
		return "节点信息不正确"
	}
	return e.Message
}

func invalid(message string) error {
	return &ValidationError{Message: message}
}

// Validate 检查注册时提交的显示名、系统、角色和能力。
// 能力列表可以为空。nil 与空列表同样表示没有能力。
func Validate(displayName, system, role string, capabilities []string) error {
	if displayName != strings.TrimSpace(displayName) {
		return invalid("显示名不能包含首尾空格")
	}
	n := utf8.RuneCountInString(displayName)
	if n < 1 || n > 80 {
		return invalid("显示名需要在 1 到 80 个字符之间")
	}
	for _, r := range displayName {
		if r < 0x20 || r == 0x7f {
			return invalid("显示名不能包含控制字符")
		}
	}
	switch system {
	case SystemWindows, SystemMacOS, SystemLinux:
	default:
		return invalid("系统需要是 windows、macos 或 linux")
	}
	switch role {
	case RolePC, RoleUbuntu:
	default:
		return invalid("角色需要是 pc 或 ubuntu")
	}
	if len(capabilities) > maxCapabilities {
		return invalid("能力数量不能超过 32 个")
	}
	seen := make(map[string]struct{}, len(capabilities))
	for _, name := range capabilities {
		if !capabilityPattern.MatchString(name) {
			return invalid("能力名称无效")
		}
		if _, ok := seen[name]; ok {
			return invalid("能力名称重复")
		}
		seen[name] = struct{}{}
	}
	return nil
}

// ValidSecret 检查一次性注册凭据或连接凭据的文本形状。
func ValidSecret(secret string) bool {
	if len(secret) < 20 || len(secret) > 200 {
		return false
	}
	for _, r := range secret {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}
