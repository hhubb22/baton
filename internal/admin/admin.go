// Package admin 提供部署管理员创建和重置本地账号的入口。
package admin

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"baton/internal/auth"
	"baton/internal/identity"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

var usernamePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,62}$`)

// CreateLocal 保存管理员分配的本地账号。password 只用于计算摘要，不写入数据库明文列。
func CreateLocal(ctx context.Context, pool *pgxpool.Pool, username, displayName, password string) (identity.Employee, error) {
	username, displayName, err := normalizeAccount(username, displayName)
	if err != nil {
		return identity.Employee{}, err
	}
	if err := auth.ValidatePassword(password, username); err != nil {
		return identity.Employee{}, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return identity.Employee{}, err
	}
	id, err := identity.NewUUID()
	if err != nil {
		return identity.Employee{}, err
	}
	emp := identity.Employee{
		ID:                 id,
		Username:           username,
		DisplayName:        displayName,
		AuthSource:         identity.SourceLocal,
		MustChangePassword: true,
	}
	if err := store.New(pool).InsertLocalEmployee(ctx, emp, hash); err != nil {
		if errors.Is(err, store.ErrUsernameTaken) {
			return identity.Employee{}, errors.New("用户名已存在")
		}
		return identity.Employee{}, err
	}
	return emp, nil
}

// ResetPassword 生成新的一次性口令，使旧口令和已有会话失效。
func ResetPassword(ctx context.Context, pool *pgxpool.Pool, username string) (string, identity.Employee, error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return "", identity.Employee{}, errors.New("用户名无效")
	}
	password, err := auth.GeneratePassword()
	if err != nil {
		return "", identity.Employee{}, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return "", identity.Employee{}, err
	}
	emp, err := store.New(pool).ResetLocalPassword(ctx, username, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", identity.Employee{}, errors.New("找不到该本地账号")
		}
		return "", identity.Employee{}, err
	}
	return password, emp, nil
}

func normalizeAccount(username, displayName string) (string, string, error) {
	if username != strings.TrimSpace(username) || !usernamePattern.MatchString(username) {
		return "", "", errors.New("用户名需要以小写字母开头，只能包含小写字母、数字、点、下划线和连字符")
	}
	displayName = strings.TrimSpace(displayName)
	n := utf8.RuneCountInString(displayName)
	if n < 1 || n > 80 {
		return "", "", errors.New("显示名需要在 1 到 80 个字符之间")
	}
	for _, r := range displayName {
		if r < 0x20 || r == 0x7f {
			return "", "", errors.New("显示名不能包含控制字符")
		}
	}
	return username, displayName, nil
}

// FormatIssuedPassword 把一次性口令写给操作者。调用方应把它放在标准输出，不要写入运行日志。
func FormatIssuedPassword(username, password string) string {
	return fmt.Sprintf("username=%s\none_time_password=%s\n", username, password)
}
