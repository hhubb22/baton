// Package auth 负责口令摘要、会话令牌和浏览器 Cookie。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	SessionCookieName = "baton_session"
	CSRFHeader        = "X-CSRF-Token"

	// OWASP 对 Argon2id 的下限：19 MiB、迭代 2、并行度 1。
	argonMemory  = 19 * 1024
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16

	minPasswordRunes = 12
	maxPasswordRunes = 128
)

var (
	ErrPasswordShort   = errors.New("口令至少需要 12 个字符")
	ErrPasswordLong    = errors.New("口令不能超过 128 个字符")
	ErrPasswordControl = errors.New("口令不能包含控制字符或首尾空格")
	ErrPasswordSame    = errors.New("口令不能与用户名相同")
)

// ValidatePassword 检查员工或管理员设定的口令。
func ValidatePassword(password, username string) error {
	if password != strings.TrimSpace(password) {
		return ErrPasswordControl
	}
	n := utf8.RuneCountInString(password)
	switch {
	case n < minPasswordRunes:
		return ErrPasswordShort
	case n > maxPasswordRunes:
		return ErrPasswordLong
	}
	for _, r := range password {
		if r < 0x20 || r == 0x7f {
			return ErrPasswordControl
		}
	}
	if username != "" && strings.EqualFold(password, username) {
		return ErrPasswordSame
	}
	return nil
}

// HashPassword 生成 Argon2id PHC 摘要。
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

type argonParams struct {
	time    uint32
	memory  uint32
	threads uint8
}

// VerifyPassword 用摘要里的参数校验口令。摘要损坏时返回错误，口令不匹配时返回 false。
func VerifyPassword(password, encoded string) (bool, error) {
	salt, params, want, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(password), salt, params.time, params.memory, params.threads, uint32(len(want)))
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return false, nil
	}
	return true, nil
}

func decodeHash(encoded string) ([]byte, argonParams, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return nil, argonParams{}, nil, errors.New("口令摘要格式无效")
	}
	var params argonParams
	var threads int
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &params.memory, &params.time, &threads); err != nil {
		return nil, argonParams{}, nil, errors.New("口令摘要参数无效")
	}
	if threads < 1 || threads > 8 || params.time < 1 || params.time > 8 || params.memory < 8*1024 || params.memory > 1024*1024 {
		return nil, argonParams{}, nil, errors.New("口令摘要参数超出允许范围")
	}
	params.threads = uint8(threads)
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return nil, argonParams{}, nil, errors.New("口令摘要盐无效")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) < 16 || len(key) > 64 {
		return nil, argonParams{}, nil, errors.New("口令摘要无效")
	}
	return salt, params, key, nil
}

var (
	dummyOnce sync.Once
	dummyHash string
	dummyErr  error
)

// DummyHash 给不存在的用户走同一套 Argon2id 计算，避免用响应快慢区分用户名。
func DummyHash() (string, error) {
	dummyOnce.Do(func() {
		pw, err := GeneratePassword()
		if err != nil {
			dummyErr = err
			return
		}
		dummyHash, dummyErr = HashPassword(pw)
	})
	return dummyHash, dummyErr
}

const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

// GeneratePassword 生成管理员下发的一次性初始口令。
func GeneratePassword() (string, error) {
	out := make([]byte, 20)
	max := big.NewInt(int64(len(passwordAlphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = passwordAlphabet[n.Int64()]
	}
	return string(out), nil
}

// NewSecret 生成 32 字节的 URL 安全随机文本。
func NewSecret() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// SessionCSRF 从高熵会话令牌派生稳定的 CSRF 令牌，域前缀隔离会话摘要。
func SessionCSRF(token string) string {
	sum := sha256.Sum256([]byte("baton:session-csrf:v1\x00" + token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Digest 计算会话令牌或 CSRF 令牌的 SHA-256。数据库只保存这个结果。
func Digest(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// SessionCookie 构造浏览器会话 Cookie。Secure、HttpOnly 和 SameSite=Strict 固定开启。
func SessionCookie(token string, expires time.Time) *http.Cookie {
	maxAge := int(time.Until(expires).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires.UTC(),
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	}
}

// ClearSessionCookie 使浏览器丢掉会话 Cookie，属性与设置时一致。
func ClearSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	}
}
