// Package identity 描述员工身份，以及将来接入外部认证时使用的映射入口。
package identity

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
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
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// ParseUUID 接受标准 UUID 文本并返回小写规范形式。
func ParseUUID(s string) (string, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return "", errors.New("invalid uuid")
	}
	canonical := id.String()
	if !strings.EqualFold(s, canonical) {
		return "", errors.New("invalid uuid")
	}
	return canonical, nil
}
