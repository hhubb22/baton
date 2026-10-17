// Package identity 描述员工身份，以及将来接入外部认证时使用的映射入口。
package identity

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	SourceLocal = "local"
)

// Employee 是可以返回给本人的身份，不包含口令摘要或会话秘密。
type Employee struct {
	ID                 string
	Username           string
	DisplayName        string
	AuthSource         string
	ExternalSubject    string
	MustChangePassword bool
}

// Directory 按已核实的外部主体查找员工。
// 调用方必须先完成外部认证；本接口不访问身份提供方，也不创建会话。
type Directory interface {
	FindExternal(ctx context.Context, source, subject string) (Employee, error)
}

// NewUUID 生成小写 UUID 版本 4。
func NewUUID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return formatUUID(raw[:]), nil
}

// ParseUUID 接受标准 UUID 文本并返回小写规范形式。
func ParseUUID(s string) (string, error) {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return "", errors.New("invalid uuid")
	}
	compact := strings.ReplaceAll(s, "-", "")
	raw, err := hex.DecodeString(compact)
	if err != nil || len(raw) != 16 {
		return "", errors.New("invalid uuid")
	}
	return formatUUID(raw), nil
}

func formatUUID(raw []byte) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}
