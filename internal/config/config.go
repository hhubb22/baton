// Package config 读取 Coordinator 的进程配置。
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	DefaultSchema            = "public"
	DefaultAddr              = "127.0.0.1:8080"
	DefaultTTL               = 12 * time.Hour
	DefaultEnrollmentTTL     = 10 * time.Minute
	DefaultNodeCredentialTTL = 30 * 24 * time.Hour
	minSessionTTL            = 5 * time.Minute
	maxSessionTTL            = 168 * time.Hour
	minEnrollmentTTL         = time.Minute
	maxEnrollmentTTL         = 24 * time.Hour
	minNodeCredentialTTL     = time.Hour
	maxNodeCredentialTTL     = 90 * 24 * time.Hour
)

// Config 是一次进程启动使用的配置。DatabaseURL 不得写入日志。
type Config struct {
	DatabaseURL       string
	Schema            string
	HTTPAddr          string
	AllowedOrigins    []string
	SessionTTL        time.Duration
	EnrollmentTTL     time.Duration
	NodeCredentialTTL time.Duration
	TLSCertFile       string
	TLSKeyFile        string
}

func (c Config) TLS() bool {
	return c.TLSCertFile != "" || c.TLSKeyFile != ""
}

// Load 从环境变量读取配置。serve 为 true 时要求 HTTPS Origin 列表。
func Load(getenv func(string) string, serve bool) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	cfg := Config{
		DatabaseURL:       strings.TrimSpace(getenv("BATON_DATABASE_URL")),
		Schema:            strings.TrimSpace(getenv("BATON_DB_SCHEMA")),
		HTTPAddr:          strings.TrimSpace(getenv("BATON_HTTP_ADDR")),
		SessionTTL:        DefaultTTL,
		EnrollmentTTL:     DefaultEnrollmentTTL,
		NodeCredentialTTL: DefaultNodeCredentialTTL,
		TLSCertFile:       strings.TrimSpace(getenv("BATON_TLS_CERT_FILE")),
		TLSKeyFile:        strings.TrimSpace(getenv("BATON_TLS_KEY_FILE")),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("需要设置 BATON_DATABASE_URL")
	}
	if cfg.Schema == "" {
		cfg.Schema = DefaultSchema
	}
	if _, err := quoteSchema(cfg.Schema); err != nil {
		return Config{}, err
	}
	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = DefaultAddr
	}
	if raw := strings.TrimSpace(getenv("BATON_SESSION_TTL")); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil {
			return Config{}, errors.New("BATON_SESSION_TTL 无效")
		}
		if ttl < minSessionTTL || ttl > maxSessionTTL {
			return Config{}, errors.New("BATON_SESSION_TTL 需要在 5m 到 168h 之间")
		}
		cfg.SessionTTL = ttl
	}
	enrollmentTTL, err := parseBoundedDuration(getenv("BATON_ENROLLMENT_TTL"), "BATON_ENROLLMENT_TTL", DefaultEnrollmentTTL, minEnrollmentTTL, maxEnrollmentTTL)
	if err != nil {
		return Config{}, err
	}
	cfg.EnrollmentTTL = enrollmentTTL
	nodeTTL, err := parseBoundedDuration(getenv("BATON_NODE_CREDENTIAL_TTL"), "BATON_NODE_CREDENTIAL_TTL", DefaultNodeCredentialTTL, minNodeCredentialTTL, maxNodeCredentialTTL)
	if err != nil {
		return Config{}, err
	}
	cfg.NodeCredentialTTL = nodeTTL
	if !serve {
		return cfg, nil
	}
	if _, _, err := net.SplitHostPort(cfg.HTTPAddr); err != nil {
		return Config{}, errors.New("BATON_HTTP_ADDR 需要是 host:port")
	}
	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return Config{}, errors.New("BATON_TLS_CERT_FILE 和 BATON_TLS_KEY_FILE 需要同时设置")
	}
	origins, err := ParseOrigins(getenv("BATON_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	cfg.AllowedOrigins = origins
	return cfg, nil
}

func quoteSchema(name string) (string, error) {
	if name == "" {
		return "", errors.New("schema 名称无效")
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '_':
		default:
			return "", errors.New("schema 名称无效")
		}
	}
	if name[0] >= '0' && name[0] <= '9' {
		return "", errors.New("schema 名称无效")
	}
	return name, nil
}

// ParseOrigins 只接受不带路径、用户信息或通配符的 https Origin。
func ParseOrigins(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("需要设置 BATON_ALLOWED_ORIGINS")
	}
	if strings.Contains(raw, "*") {
		return nil, errors.New("Origin 必须是不带路径的 https 来源")
	}
	var out []string
	seen := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, errors.New("Origin 必须是不带路径的 https 来源")
		}
		normalized, err := NormalizeOrigin(part)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil, errors.New("需要设置 BATON_ALLOWED_ORIGINS")
	}
	return out, nil
}

// NormalizeOrigin 把浏览器 Origin 规范成小写的 scheme://host[:port]。
func NormalizeOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || !u.IsAbs() {
		return "", errors.New("Origin 必须是不带路径的 https 来源")
	}
	if strings.ToLower(u.Scheme) != "https" || u.User != nil {
		return "", errors.New("Origin 必须是不带路径的 https 来源")
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("Origin 必须是不带路径的 https 来源")
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && port != "443" {
		host += ":" + port
	}
	return "https://" + host, nil
}

// OriginSet 便于按规范形式查找。
func OriginSet(origins []string) (map[string]struct{}, error) {
	set := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		normalized, err := NormalizeOrigin(origin)
		if err != nil {
			return nil, err
		}
		set[normalized] = struct{}{}
	}
	if len(set) == 0 {
		return nil, errors.New("需要设置 BATON_ALLOWED_ORIGINS")
	}
	return set, nil
}

// Redacted 返回可以记录的配置摘要，不包含数据库连接串。
func (c Config) Redacted() string {
	return fmt.Sprintf("schema=%s addr=%s origins=%d ttl=%s enrollment_ttl=%s node_credential_ttl=%s tls=%t",
		c.Schema, c.HTTPAddr, len(c.AllowedOrigins), c.SessionTTL, c.EnrollmentTTL, c.NodeCredentialTTL, c.TLS())
}

func parseBoundedDuration(raw, name string, fallback, min, max time.Duration) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	ttl, err := time.ParseDuration(raw)
	if err != nil {
		return 0, errors.New(name + " 无效")
	}
	if ttl < min || ttl > max {
		return 0, fmt.Errorf("%s 需要在 %s 到 %s 之间", name, min, max)
	}
	return ttl, nil
}
